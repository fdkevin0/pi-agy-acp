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
  rmSync,
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
  relative,
  resolve,
} from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readJson } from './config.ts'

/** Agent id installed in the isolated home. */
export const BRIDGE_AGENT = 'pi-bridge'
/** Minimum official CLI version supported (`agy 1.5.10+`). */
export const MIN_AGY_VERSION: readonly [number, number, number] = [1, 5, 10]

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

/** Context window telemetry decoded from `gen_metadata.data`. */
export interface ContextWindowMetadata {
  maxContextTokens?: number
  estimatedTokensUsed?: number
}

function decodeCtxWindow(
  ctxWindow: Uint8Array,
): ContextWindowMetadata | undefined {
  let maxContextTokens: number | undefined
  let estimatedTokensUsed: number | undefined
  let pos = 0
  while (pos < ctxWindow.length) {
    const tag = readVarint(ctxWindow, pos)
    if (tag === undefined) break
    pos = tag.next
    const fieldNumber = Number(tag.value >> 3n)
    const wireType = Number(tag.value & 7n)
    if (fieldNumber <= 0) break
    if (wireType === 0 && (fieldNumber === 1 || fieldNumber === 4)) {
      const val = readVarint(ctxWindow, pos)
      if (val === undefined) break
      pos = val.next
      const num = Number(val.value)
      if (val.value > 0n && Number.isSafeInteger(num)) {
        if (fieldNumber === 1) estimatedTokensUsed = num
        else maxContextTokens = num
      }
      continue
    }
    const next = skipField(ctxWindow, pos, wireType)
    if (next === undefined) break
    pos = next
  }
  if (maxContextTokens === undefined && estimatedTokensUsed === undefined)
    return undefined
  return {
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
    ...(estimatedTokensUsed !== undefined ? { estimatedTokensUsed } : {}),
  }
}

/**
 * Decode context window telemetry from `gen_metadata.data` along protobuf wire path
 * `1 (chatModel) -> 9 (chatStart) -> 10 (ctxWindow) -> {1: estimated_tokens_used, 4: max_context_tokens}`.
 * @param blob - raw protobuf bytes from `gen_metadata.data`.
 * @returns positive token counts, or `undefined` when absent or malformed.
 */
export function extractContextWindowMetadata(
  blob: Uint8Array,
): ContextWindowMetadata | undefined {
  if (!(blob instanceof Uint8Array) || blob.length === 0) return undefined
  return scanMessage(blob, 1, 2, (chatModel) =>
    scanMessage(chatModel, 9, 2, (chatStart) =>
      scanMessage(chatStart, 10, 2, (ctxWindow) => decodeCtxWindow(ctxWindow)),
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

  // Reject symlinked or non-regular SQLite WAL/SHM sidecar files before opening.
  for (const suffix of ['-wal', '-shm']) {
    const sidecarStat = lstatOrMissing(`${dbPath}${suffix}`)
    if (sidecarStat === 'missing') continue
    if (
      sidecarStat === 'invalid' ||
      sidecarStat.isSymbolicLink() ||
      !sidecarStat.isFile()
    ) {
      return { kind: 'invalid' }
    }
  }

  return { kind: 'ok', dbPath }
}

/**
 * Read context window telemetry (`max_context_tokens` and `estimated_tokens_used`)
 * from one ACP session's SQLite database.
 * @param home - isolated `--gemini-dir` root.
 * @param sessionId - ACP session id.
 * @param minIdx - lowest `gen_metadata.idx` owned by the current scope.
 * @returns decoded positive counts, or `undefined` when unavailable.
 */
export function readSessionContextMetadata(
  home: string,
  sessionId: string,
  minIdx = 0,
): ContextWindowMetadata | undefined {
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
    let maxContextTokens: number | undefined
    let estimatedTokensUsed: number | undefined
    for (const row of stmt.iterate(minIdx) as Iterable<{ data?: unknown }>) {
      if (!(row.data instanceof Uint8Array)) continue
      const meta = extractContextWindowMetadata(row.data)
      if (meta === undefined) continue
      if (maxContextTokens === undefined && meta.maxContextTokens !== undefined)
        maxContextTokens = meta.maxContextTokens
      if (
        estimatedTokensUsed === undefined &&
        meta.estimatedTokensUsed !== undefined
      )
        estimatedTokensUsed = meta.estimatedTokensUsed
      if (maxContextTokens !== undefined && estimatedTokensUsed !== undefined)
        break
    }
    if (maxContextTokens === undefined && estimatedTokensUsed === undefined)
      return undefined
    return {
      ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
      ...(estimatedTokensUsed !== undefined ? { estimatedTokensUsed } : {}),
    }
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
