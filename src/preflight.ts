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
  realpathSync,
  statSync,
  lstatSync,
  readdirSync,
  rmSync,
  type Stats,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readJson } from './config.ts'

/** Agent id installed in the isolated home. */
export const BRIDGE_AGENT = 'pi-bridge'
/** Minimum official CLI version supporting `agy acp --process-per-session`. */
export const MIN_AGY_VERSION: readonly [number, number, number] = [1, 4, 12]

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

const EMPTY_BYTES = new Uint8Array(0)
const MAX_VARINT_SHIFT = 63n

function isValidSessionId(sessionId: string): boolean {
  return (
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    !/[^A-Za-z0-9._-]/.test(sessionId) &&
    sessionId !== '.' &&
    !sessionId.includes('..')
  )
}

function readVarint(
  buf: Uint8Array,
  start: number,
): { value: bigint; next: number } | undefined {
  let value = 0n
  let shift = 0n
  let pos = start
  while (pos < buf.length && shift <= MAX_VARINT_SHIFT) {
    const byte = buf[pos++] as number
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, next: pos }
    shift += 7n
  }
  return undefined
}

function skipField(
  buf: Uint8Array,
  pos: number,
  wireType: number,
): number | undefined {
  if (wireType === 0) return readVarint(buf, pos)?.next
  if (wireType === 1) return pos + 8 <= buf.length ? pos + 8 : undefined
  if (wireType === 2) {
    const len = readVarint(buf, pos)
    if (len === undefined) return undefined
    const byteLen = Number(len.value)
    if (!Number.isSafeInteger(byteLen) || byteLen < 0) return undefined
    const end = len.next + byteLen
    return end <= buf.length ? end : undefined
  }
  if (wireType === 5) return pos + 4 <= buf.length ? pos + 4 : undefined
  return undefined
}

function scanMessage<T>(
  buf: Uint8Array,
  targetField: number,
  expectedWireType: 0 | 2,
  onMatch: (payload: Uint8Array, varint: bigint) => T | undefined,
): T | undefined {
  let pos = 0
  let result: T | undefined
  while (pos < buf.length) {
    const tag = readVarint(buf, pos)
    if (tag === undefined) break
    pos = tag.next
    const fieldNumber = Number(tag.value >> 3n)
    const wireType = Number(tag.value & 7n)
    if (fieldNumber <= 0) break
    if (fieldNumber === targetField && wireType === expectedWireType) {
      if (wireType === 0) {
        const val = readVarint(buf, pos)
        if (val === undefined) break
        pos = val.next
        const matched = onMatch(EMPTY_BYTES, val.value)
        if (matched !== undefined) result = matched
        continue
      }
      const len = readVarint(buf, pos)
      if (len === undefined) break
      const byteLen = Number(len.value)
      if (!Number.isSafeInteger(byteLen) || byteLen < 0) break
      const end = len.next + byteLen
      if (end > buf.length) break
      const matched = onMatch(buf.subarray(len.next, end), 0n)
      if (matched !== undefined) result = matched
      pos = end
      continue
    }
    const next = skipField(buf, pos, wireType)
    if (next === undefined) break
    pos = next
  }
  return result
}

/**
 * Decode `max_context_tokens` from `gen_metadata.data` along protobuf wire path
 * `1 (bytes) -> 9 (bytes) -> 10 (bytes) -> 4 (varint)`.
 * @param blob - raw protobuf bytes from `gen_metadata.data`.
 * @returns positive token count, or `undefined` when absent or malformed.
 */
export function extractMaxContextTokens(blob: Uint8Array): number | undefined {
  if (!(blob instanceof Uint8Array) || blob.length === 0) return undefined
  return scanMessage(blob, 1, 2, (chatModel) =>
    scanMessage(chatModel, 9, 2, (chatStart) =>
      scanMessage(chatStart, 10, 2, (ctxWindow) =>
        scanMessage(ctxWindow, 4, 0, (_empty, value) => {
          const num = Number(value)
          return value > 0n && Number.isSafeInteger(num) ? num : undefined
        }),
      ),
    ),
  )
}

function lstatOrMissing(path: string): Stats | 'missing' | 'invalid' {
  try {
    return lstatSync(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? 'missing'
      : 'invalid'
  }
}

function resolveSessionDbPath(
  home: string,
  sessionId: string,
): { kind: 'ok'; dbPath: string } | { kind: 'missing' } | { kind: 'invalid' } {
  if (!isValidSessionId(sessionId)) return { kind: 'invalid' }
  const appData = join(home, 'agy')
  const appStat = lstatOrMissing(appData)
  if (appStat === 'missing') return { kind: 'missing' }
  if (
    appStat === 'invalid' ||
    appStat.isSymbolicLink() ||
    !appStat.isDirectory()
  )
    return { kind: 'invalid' }

  const convDir = join(appData, 'conversations')
  const convStat = lstatOrMissing(convDir)
  if (convStat === 'missing') return { kind: 'missing' }
  if (
    convStat === 'invalid' ||
    convStat.isSymbolicLink() ||
    !convStat.isDirectory()
  )
    return { kind: 'invalid' }

  let realHome: string
  let realConvDir: string
  try {
    realHome = realpathSync(home)
    realConvDir = realpathSync(convDir)
  } catch {
    return { kind: 'invalid' }
  }
  const rel = relative(realHome, realConvDir)
  if (rel.startsWith('..') || isAbsolute(rel)) return { kind: 'invalid' }

  const dbPath = join(convDir, `${sessionId}.db`)
  const dbStat = lstatOrMissing(dbPath)
  if (dbStat === 'missing') return { kind: 'missing' }
  if (dbStat === 'invalid' || dbStat.isSymbolicLink() || !dbStat.isFile())
    return { kind: 'invalid' }

  return { kind: 'ok', dbPath }
}

/**
 * Read server-issued `max_context_tokens` from one ACP session's SQLite database.
 * @param home - isolated `--gemini-dir` root.
 * @param sessionId - ACP session id.
 * @param minIdx - lowest `gen_metadata.idx` owned by the current model.
 * @returns positive `max_context_tokens`, or `undefined` when unavailable.
 */
export function readSessionMaxContextTokens(
  home: string,
  sessionId: string,
  minIdx = 0,
): number | undefined {
  if (typeof minIdx !== 'number' || !Number.isSafeInteger(minIdx) || minIdx < 0)
    return undefined
  const resolved = resolveSessionDbPath(home, sessionId)
  if (resolved.kind !== 'ok') return undefined
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(resolved.dbPath, { readOnly: true, timeout: 50 })
    const stmt = db.prepare(
      'SELECT data FROM gen_metadata WHERE idx >= ? ORDER BY idx DESC',
    )
    for (const row of stmt.iterate(minIdx) as Iterable<{ data?: unknown }>) {
      if (!(row.data instanceof Uint8Array)) continue
      const tokens = extractMaxContextTokens(row.data)
      if (tokens !== undefined) return tokens
    }
    return undefined
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

/**
 * Compute the next `gen_metadata.idx` floor (`MAX(idx) + 1`, or `0` when no rows exist)
 * before switching models inside a reused ACP session. Returns `null` when the
 * session database path is invalid, symlinked, corrupt, or unreadable (fail-closed).
 */
export function readSessionNextMetadataIndex(
  home: string,
  sessionId: string,
): number | null {
  const resolved = resolveSessionDbPath(home, sessionId)
  if (resolved.kind === 'missing') return 0
  if (resolved.kind === 'invalid') return null
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(resolved.dbPath, { readOnly: true, timeout: 50 })
    const hasTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gen_metadata'",
      )
      .get()
    if (hasTable === undefined) return 0
    const row = db
      .prepare('SELECT MAX(idx) AS maxIdx FROM gen_metadata')
      .get() as { maxIdx?: unknown } | undefined
    if (row?.maxIdx === null || row?.maxIdx === undefined) return 0
    if (typeof row.maxIdx === 'number' && Number.isSafeInteger(row.maxIdx)) {
      const next = row.maxIdx + 1
      return Number.isSafeInteger(next) ? Math.max(0, next) : null
    }
    return null
  } catch {
    return null
  } finally {
    db?.close()
  }
}

/** Remove only one closed ACP session's files; session ids come from the agent. */
export function removeSessionArtifacts(home: string, sessionId: string): void {
  if (!isValidSessionId(sessionId)) return
  const appData = join(home, 'agy')
  if (!isRealDirectory(appData)) return
  removeArtifacts(join(appData, 'conversations'), [
    `${sessionId}.db`,
    `${sessionId}.db-wal`,
    `${sessionId}.db-shm`,
  ])
  removeArtifacts(join(appData, 'brain'), [sessionId])
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function removeArtifacts(directory: string, names: readonly string[]): void {
  // Never follow a replaced parent directory into data outside the isolated home.
  if (!isRealDirectory(directory)) return
  for (const name of names) {
    try {
      rmSync(join(directory, name), { recursive: true, force: true })
    } catch {
      // Locked or unreadable leftovers can be retried on the next startup.
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
  // Pi owns conversation history; no ACP session is restored across processes.
  // shortcut: cleanup requires an exclusive home; add locking before supporting shared homes.
  removeArtifacts(appData, [
    'conversations',
    'brain',
    'conversation_summaries.db',
    'conversation_summaries.db-wal',
    'conversation_summaries.db-shm',
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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
