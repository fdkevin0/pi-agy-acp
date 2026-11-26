/**
 * Startup preparation: locate the official `agy` binary and lay out the isolated
 * Antigravity home that ACP sessions use.
 *
 * The isolated home keeps the user's global Antigravity rules, skills, and
 * MCP servers out of Pi sessions and installs the `pi-bridge` agent, which
 * removes every built-in tool so the agent acts only through Pi tools.
 * @module pi-agy-acp/preflight
 */

import { randomBytes } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  lstatSync,
  readdirSync,
  unlinkSync,
  type BigIntStats,
  type Stats,
} from 'node:fs'
import { homedir } from 'node:os'
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'
import { readJson } from './config.ts'
import { removeArtifacts } from './session-db.ts'

/** Agent id installed in the isolated home. */
export const BRIDGE_AGENT = 'pi-bridge'
/** Minimum official CLI version supported (`agy 1.5.18+`). */
export const MIN_AGY_VERSION: readonly [number, number, number] = [1, 5, 18]

/** Output of one finished helper command. */
export interface CommandOutput {
  code: number | null
  stdout: string
  stderr: string
  /** Set when aborted early by stderr match, stdout cap, timeout, or signal. */
  abortedBy?: 'stderr' | 'maxStdout' | 'timeout' | 'signal'
}

/** Optional execution controls for one helper command. */
export interface CommandOptions {
  /** Maximum stdout bytes buffered before aborting the command. */
  maxStdoutBytes?: number
  /** Abort the command early when buffered stderr matches this pattern. */
  abortOnStderr?: RegExp
  /** Cancel the command externally. */
  signal?: AbortSignal
}

/** Runs one helper command to completion. */
export type CommandRunner = (
  argv: readonly string[],
  timeoutMs: number,
  options?: CommandOptions,
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

function getEnvCaseInsensitive(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const direct = env[key]
  if (direct !== undefined) return direct
  const lower = key.toLowerCase()
  for (const [entryKey, value] of Object.entries(env)) {
    if (entryKey.toLowerCase() === lower && value !== undefined) return value
  }
  return undefined
}

function splitPathDirs(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const raw = getEnvCaseInsensitive(env, 'PATH') ?? ''
  const sep = platform === 'win32' ? ';' : delimiter
  const dirs: string[] = []
  for (const part of raw.split(sep)) {
    const cleaned = part.trim().replace(/^"(.*)"$/, '$1')
    if (cleaned.length > 0) dirs.push(cleaned)
  }
  return dirs
}

function winPathExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = getEnvCaseInsensitive(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD'
  const seen = new Set<string>()
  const exts: string[] = []
  for (const part of raw.split(';')) {
    const trimmed = part.trim().toLowerCase()
    if (trimmed.length === 0) continue
    const ext = trimmed.startsWith('.') ? trimmed : `.${trimmed}`
    if (seen.has(ext)) continue
    seen.add(ext)
    exts.push(ext)
  }
  if (!seen.has('.exe')) exts.unshift('.exe')
  return exts
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
  const platform = options.platform ?? process.platform
  if (configured.length > 0) {
    if (!isAbsolute(configured))
      throw new Error(
        `antigravity-acp: command must be an absolute path, got ${configured}`,
      )
    if (!isExecutableFile(configured, platform))
      throw new Error(
        `antigravity-acp: configured agy binary not found at ${configured}`,
      )
    return configured
  }
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const candidates: string[] = []
  if (platform === 'win32') {
    const localAppData =
      getEnvCaseInsensitive(env, 'LOCALAPPDATA') ||
      join(home, 'AppData', 'Local')
    candidates.push(join(localAppData, 'agy', 'bin', 'agy.exe'))
    candidates.push(join(home, '.local', 'bin', 'agy.exe'))
    const pathDirs = splitPathDirs(env, platform)
    const exts = winPathExtensions(env)
    // Prefer native agy.exe across PATH before PATHEXT wrapper shims (such as IDE agy.cmd).
    for (const dir of pathDirs) {
      candidates.push(join(dir, 'agy.exe'))
    }
    for (const dir of pathDirs) {
      for (const ext of exts) {
        if (ext !== '.exe') candidates.push(join(dir, `agy${ext}`))
      }
    }
  } else {
    candidates.push(join(home, '.local', 'bin', 'agy'))
    for (const dir of splitPathDirs(env, platform)) {
      candidates.push(join(dir, 'agy'))
    }
  }
  const found = candidates.find((candidate) =>
    isExecutableFile(candidate, platform),
  )
  if (found === undefined) {
    throw new Error(
      'antigravity-acp: the Antigravity CLI (agy) was not found; install it from https://antigravity.google/docs/install?tab=cli and sign in once with `agy` (or `agy acp --login` for headless/SSH setups)',
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
 * Compute a subprocess-free identity fingerprint for a resolved `agy` binary.
 * @param binary - path to the executable.
 * @returns `${real}:${dev}:${ino}:${size}:${mtimeNs}`, or `undefined` when unavailable.
 */
export function binaryFingerprint(binary: string): string | undefined {
  if (!binary) return undefined
  try {
    const real = realpathSync(binary)
    const st = statSync(real, { bigint: true })
    if (!st.isFile()) return undefined
    return `${real}:${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`
  } catch {
    return undefined
  }
}

/**
 * Default Antigravity CLI directories in priority order:
 * `ANTIGRAVITY_CLI_HOME`, then `AGY_HOME`, then `~/.gemini/antigravity-cli`.
 */
export function defaultAgyHomes(
  userHome: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates = [
    env.ANTIGRAVITY_CLI_HOME?.trim(),
    env.AGY_HOME?.trim(),
    join(userHome, '.gemini', 'antigravity-cli'),
  ]
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const dir of candidates) {
    if (!dir) continue
    const normalized = resolve(dir)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    dirs.push(normalized)
  }
  return dirs
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
 * Whether `home` points to the default isolated Pi Antigravity home
 * (`~/.pi/agent/cache/antigravity-acp`) rather than a custom `PI_AGY_HOME`.
 */
export function isDefaultPiAgyHome(
  home: string,
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  const actual = resolve(home)
  const expected = resolve(
    join(userHome, '.pi', 'agent', 'cache', 'antigravity-acp'),
  )
  return platform === 'win32'
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected
}

function ensureRealDirectory(
  root: string,
  segments: readonly string[],
): string {
  let rootStat: Stats | undefined
  try {
    rootStat = lstatSync(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }
  if (rootStat === undefined) {
    mkdirSync(root, { recursive: true })
  } else if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Refusing to use symlink or non-directory path: ${root}`)
  }
  let current = root
  for (const segment of segments) {
    current = join(current, segment)
    let st: Stats | undefined
    try {
      st = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    if (st === undefined) {
      mkdirSync(current)
    } else if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(
        `Refusing to use symlink or non-directory path: ${current}`,
      )
    }
  }
  return current
}

/**
 * Atomically write a regular file in the target directory while rejecting
 * symlinked or non-regular destination paths.
 */
export function atomicWriteFile(
  path: string,
  content: string | Uint8Array,
  options?: { mode?: number },
): void {
  let existing: Stats | undefined
  try {
    existing = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }
  if (
    existing !== undefined &&
    (existing.isSymbolicLink() || !existing.isFile())
  ) {
    throw new Error(
      `Refusing to write to symlink or non-regular file: ${path}`,
    )
  }
  const tmpPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  )
  const mode = options?.mode
  let fd: number | undefined
  let created = false
  try {
    fd = openSync(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      mode ?? 0o666,
    )
    created = true
    writeFileSync(fd, content)
    closeSync(fd)
    fd = undefined
    if (mode !== undefined) {
      try {
        chmodSync(tmpPath, mode)
      } catch {
        // Mode bits are advisory on Windows.
      }
    }
    renameSync(tmpPath, path)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Ignore close errors during cleanup.
      }
    }
    if (created) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // Best-effort temp file cleanup.
      }
    }
    throw error
  }
}

/**
 * Seed or refresh the isolated `antigravity-oauth-token` file from the user's
 * Antigravity CLI home (`ANTIGRAVITY_CLI_HOME`, `AGY_HOME`, or
 * `~/.gemini/antigravity-cli`) whenever the default `PI_AGY_HOME` is in use
 * and the host uses file-backed token storage. Custom `PI_AGY_HOME` roots stay
 * strictly isolated.
 * @param home - isolated `--gemini-dir` root.
 * @param userHome - optional user home override for testing.
 * @param env - optional environment override for testing.
 */
export function syncOAuthToken(
  home: string,
  userHome: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isDefaultPiAgyHome(home, userHome)) return
  const appData = join(home, 'agy')
  const dst = join(appData, 'antigravity-oauth-token')
  let appStat: Stats | undefined
  try {
    appStat = lstatSync(appData)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }
  if (
    appStat !== undefined &&
    (appStat.isSymbolicLink() || !appStat.isDirectory())
  ) {
    throw new Error(
      `Refusing to sync OAuth token into symlink or non-directory path: ${appData}`,
    )
  }
  let dstStat: BigIntStats | undefined
  try {
    dstStat = lstatSync(dst, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }
  if (
    dstStat !== undefined &&
    (dstStat.isSymbolicLink() || !dstStat.isFile())
  ) {
    throw new Error(
      `Refusing to overwrite symlink or non-regular OAuth token: ${dst}`,
    )
  }
  let chosenFd: number | undefined
  let chosenPath: string | undefined
  let chosenStat: BigIntStats | undefined
  const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  try {
    for (const dir of defaultAgyHomes(userHome, env)) {
      const candidate = join(dir, 'antigravity-oauth-token')
      let fd: number | undefined
      try {
        // Pre-check symlink for platforms where O_NOFOLLOW is unavailable (Windows).
        if (lstatSync(candidate).isSymbolicLink()) continue
        fd = openSync(candidate, openFlags)
        const st = fstatSync(fd, { bigint: true })
        if (st.isFile() && st.size > 0n) {
          chosenFd = fd
          chosenPath = candidate
          chosenStat = st
          fd = undefined
          break
        }
      } catch {
        // Directory has no usable token file; fall through to the next candidate.
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd)
          } catch {
            // Ignore close errors while probing candidates.
          }
        }
      }
    }
    if (
      chosenFd === undefined ||
      chosenPath === undefined ||
      chosenStat === undefined
    )
      return
    if (resolve(chosenPath) === resolve(dst)) return
    if (dstStat !== undefined) {
      if (
        dstStat.ino !== 0n &&
        dstStat.dev === chosenStat.dev &&
        dstStat.ino === chosenStat.ino
      )
        return
      if (dstStat.size > 0n && dstStat.mtimeNs >= chosenStat.mtimeNs) return
    }
    const content = readFileSync(chosenFd)
    ensureRealDirectory(home, ['agy'])
    atomicWriteFile(dst, content, { mode: 0o600 })
  } finally {
    if (chosenFd !== undefined) {
      try {
        closeSync(chosenFd)
      } catch {
        // Ignore close errors after reading.
      }
    }
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
  env: NodeJS.ProcessEnv = process.env,
  onWarn?: (message: string) => void,
): string {
  const pluginDir = ensureRealDirectory(home, [
    'config',
    'plugins',
    BRIDGE_AGENT,
  ])
  const agentDir = ensureRealDirectory(pluginDir, ['agents'])
  writeIfChanged(
    join(pluginDir, 'plugin.json'),
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
  const appData = ensureRealDirectory(home, ['agy'])
  // Pi owns conversation history; no ACP session is restored across processes.
  // shortcut: cleanup requires an exclusive home; add locking before supporting shared homes.
  removeArtifacts(appData, [
    'conversations',
    'brain',
    'annotations',
    'conversation_summaries.db',
    'conversation_summaries.db-wal',
    'conversation_summaries.db-shm',
    'conversation_summaries.db-journal',
    'jetbox_summaries_proto.pb',
  ])
  try {
    removeArtifacts(
      home,
      readdirSync(home).filter((name) => /^acp\.log\.\d+$/.test(name)),
    )
  } catch {
    // Log cleanup is best-effort when the home cannot be listed.
  }
  try {
    syncOAuthToken(home, userHome, env)
  } catch (error) {
    onWarn?.(
      `antigravity-acp: OAuth token sync skipped: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const settingsPath = join(appData, 'settings.json')
  const settings = readJson(settingsPath)
  writeIfChanged(
    settingsPath,
    `${JSON.stringify({ ...settings, toolPermission: 'request-review', agentMode: '' }, null, 2)}\n`,
  )
  const workspace = ensureRealDirectory(home, ['workspace'])
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
  let existing: Stats | undefined
  try {
    existing = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(
        `Refusing to write to symlink or non-regular file: ${path}`,
      )
    }
    if (readFileSync(path, 'utf8') === content) return
  }
  atomicWriteFile(path, content)
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== 'win32' && process.platform !== 'win32') {
      accessSync(path, fsConstants.X_OK)
    }
    return true
  } catch {
    return false
  }
}
