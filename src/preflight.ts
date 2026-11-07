/**
 * Startup preparation: locate the official `agy` binary and lay out the isolated
 * Antigravity home that ACP sessions use.
 *
 * The isolated home keeps the user's global Antigravity rules, skills, and
 * MCP servers out of Pi sessions and installs the `pi-bridge` agent, which
 * removes every built-in tool so the agent acts only through Pi tools.
 * @module pi-agy-acp/preflight
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** Agent id installed in the isolated home. */
export const BRIDGE_AGENT = 'pi-bridge'
/** Minimum official CLI version supporting `agy acp --process-per-session`. */
export const MIN_AGY_VERSION: readonly [number, number, number] = [1, 4, 12]
/** Default context window for the official CLI. */
export const DEFAULT_CONTEXT_WINDOW = 256_000
/** GPT-OSS 120B has its own 128K-class window. */
export const GPT_OSS_CONTEXT_WINDOW = 131_072

/** Output of one finished helper command. */
export interface CommandOutput {
  code: number | null
  stdout: string
  stderr: string
}

/** Runs one helper command to completion. */
export type CommandRunner = (
  argv: readonly string[],
  timeoutMs: number,
) => Promise<CommandOutput>

/** Prepared launch facts. */
export interface PreflightResult {
  binary: string
  version: string
  home: string
  workspace: string
  logFile: string
}

/** Platform/environment overrides for executable discovery tests. */
export interface ResolveBinaryOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
}

function splitPathDirs(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const raw = env.PATH ?? env.Path ?? ''
  const sep = platform === 'win32' ? ';' : delimiter
  const dirs: string[] = []
  for (const part of raw.split(sep)) {
    const cleaned = part.trim().replace(/^"(.*)"$/, '$1')
    if (cleaned.length > 0) dirs.push(cleaned)
  }
  return dirs
}

/**
 * Locate the `agy` executable.
 * @param configured - configured absolute path, or empty.
 * @param options - optional platform/env overrides for testing.
 * @returns the executable path.
 */
export function resolveAgyBinary(
  configured: string,
  options: ResolveBinaryOptions = {},
): string {
  if (configured.length > 0) {
    if (!isAbsolute(configured))
      throw new Error(
        `antigravity-acp: command must be an absolute path, got ${configured}`,
      )
    if (!isFile(configured))
      throw new Error(
        `antigravity-acp: configured agy binary not found at ${configured}`,
      )
    return configured
  }
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const exeName = platform === 'win32' ? 'agy.exe' : 'agy'
  const candidates: string[] = []
  if (platform === 'win32') {
    const localAppData =
      env.LOCALAPPDATA && env.LOCALAPPDATA.length > 0
        ? env.LOCALAPPDATA
        : join(home, 'AppData', 'Local')
    candidates.push(join(localAppData, 'agy', 'bin', 'agy.exe'))
    candidates.push(join(home, '.local', 'bin', 'agy.exe'))
  } else {
    candidates.push(join(home, '.local', 'bin', 'agy'))
  }
  for (const dir of splitPathDirs(env, platform)) {
    candidates.push(join(dir, exeName))
  }
  const found = candidates.find((candidate) => isFile(candidate))
  if (found === undefined) {
    throw new Error(
      'antigravity-acp: the Antigravity CLI (agy) was not found; install it from https://antigravity.google/docs/install?tab=cli and sign in once with `agy`',
    )
  }
  return found
}

/**
 * Reject outdated official `agy` binaries that predate ACP multi-session support.
 * Non-semver diagnostic strings (`unknown`, test doubles) pass through.
 * @param version - version string from `readVersion`.
 * @param binary - resolved executable path.
 */
export function assertSupportedAgyVersion(
  version: string,
  binary: string,
): void {
  const match = /^(?:antigravity(?:\s+cli)?\s+)?v?(\d+)\.(\d+)\.(\d+)\b/i.exec(
    version.trim(),
  )
  if (match === null) return
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  const [minMajor, minMinor, minPatch] = MIN_AGY_VERSION
  const supported =
    major > minMajor ||
    (major === minMajor &&
      (minor > minMinor || (minor === minMinor && patch >= minPatch)))
  if (!supported) {
    throw new Error(
      `antigravity-acp: Antigravity CLI ${version.trim()} at ${binary} is too old (requires >= ${MIN_AGY_VERSION.join('.')}); run \`agy update\` to upgrade`,
    )
  }
}

/**
 * Default isolated home.
 * @returns `~/.pi/agent/cache/antigravity-acp`.
 */
export function defaultHome(): string {
  return (
    process.env.PI_AGY_HOME ||
    join(homedir(), '.pi', 'agent', 'cache', 'antigravity-acp')
  )
}

/**
 * Seed or refresh the isolated `antigravity-oauth-token` file from the user's
 * default CLI home (`~/.gemini/antigravity-cli` or `~/.gemini/antigravity`)
 * whenever the host uses file-backed token storage (Windows / headless Linux)
 * or the user signed in again from a terminal.
 * @param home - isolated `--gemini-dir` root.
 * @param userHome - optional user home override for testing.
 */
export function syncOAuthToken(
  home: string,
  userHome: string = homedir(),
): void {
  const appData = join(home, 'agy')
  const dst = join(appData, 'antigravity-oauth-token')
  const sources = [
    join(userHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    join(userHome, '.gemini', 'antigravity', 'antigravity-oauth-token'),
  ]
  let newestSrc: { path: string; mtimeMs: number } | undefined
  for (const candidate of sources) {
    try {
      const st = statSync(candidate)
      if (
        st.size > 0 &&
        (newestSrc === undefined || st.mtimeMs > newestSrc.mtimeMs)
      ) {
        newestSrc = { path: candidate, mtimeMs: st.mtimeMs }
      }
    } catch {
      // Source token file does not exist.
    }
  }
  if (newestSrc === undefined) return
  try {
    const dstStat = statSync(dst)
    if (dstStat.size > 0 && dstStat.mtimeMs >= newestSrc.mtimeMs) return
  } catch {
    // Destination token file does not exist yet.
  }
  mkdirSync(appData, { recursive: true })
  copyFileSync(newestSrc.path, dst)
  try {
    chmodSync(dst, 0o600)
  } catch {
    // Mode bits are advisory on Windows.
  }
}

/**
 * Write the isolated Antigravity home: bridge agent and ACP settings.
 * @param home - absolute home directory used as `--gemini-dir`.
 * @param userHome - optional user home override for testing.
 * @returns the empty workspace directory used as every session's cwd.
 */
export function prepareHome(
  home: string,
  userHome: string = homedir(),
): string {
  const agentDir = join(home, 'config', 'plugins', BRIDGE_AGENT, 'agents')
  mkdirSync(agentDir, { recursive: true })
  writeIfChanged(
    join(home, 'config', 'plugins', BRIDGE_AGENT, 'plugin.json'),
    `${JSON.stringify({ name: BRIDGE_AGENT }, null, 2)}\n`,
  )
  writeIfChanged(
    join(agentDir, `${BRIDGE_AGENT}.md`),
    [
      '---',
      `name: ${BRIDGE_AGENT}`,
      'description: "Pi primary-model bridge: no built-in tools, harness tools only"',
      'tools: []',
      'excludeDefaultComponents: true',
      'mainAgent: true',
      '---',
      'Follow the appended system instructions exactly. Act only through the harness tools you are given.',
      '',
    ].join('\n'),
  )
  const appData = join(home, 'agy')
  mkdirSync(appData, { recursive: true })
  syncOAuthToken(home, userHome)
  const settingsPath = join(appData, 'settings.json')
  const settings = readJson(settingsPath)
  writeIfChanged(
    settingsPath,
    `${JSON.stringify({ ...settings, toolPermission: 'request-review', agentMode: '' }, null, 2)}\n`,
  )
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  return workspace
}

/**
 * Read the agy version.
 * @param binary - agy executable.
 * @param run - helper command runner.
 * @returns the version text, or `unknown`.
 */
export async function readVersion(
  binary: string,
  run: CommandRunner,
): Promise<string> {
  try {
    const result = await run([binary, '--version'], 30_000)
    return (
      (result.stdout.trim() || result.stderr.trim()).split('\n')[0] ?? 'unknown'
    )
  } catch (_versionFailure) {
    // The version is diagnostic only.
    return 'unknown'
  }
}

function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return
  writeFileSync(path, content)
}

function readJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch (_missingSettings) {
    // A missing or unreadable settings file starts empty.
    return {}
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
