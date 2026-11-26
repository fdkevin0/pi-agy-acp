/**
 * Read-only SQLite session database access, protobuf context-window decoding,
 * hidden upstream API error classification, and scoped artifact cleanup.
 * @module pi-agy-acp/session-db
 */

import {
  lstatSync,
  realpathSync,
  rmSync,
  type BigIntStats,
  type Stats,
} from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const EMPTY_BYTES = new Uint8Array(0)
const MAX_VARINT_SHIFT = 63n
const DEFAULT_MAX_META_ROWS = 64

/** Context window telemetry decoded from `gen_metadata.data`. */
export interface ContextWindowMetadata {
  maxContextTokens?: number
  estimatedTokensUsed?: number
}

/** Result of validating and statting one session's SQLite database and sidecars. */
export type ResolvedSessionDb =
  | { kind: 'ok'; dbPath: string; stamp: string }
  | { kind: 'missing' }
  | { kind: 'invalid' }

/** Per-table high-water marks read before a prompt segment begins. */
export interface SessionCursors {
  nextMetaIdx: number
  lastStepIdx: number
}

/** Classified failure hidden inside a session's `steps` table after `end_turn` or `refusal`. */
export type HiddenTurnErrorKind =
  | 'quota'
  | 'invalid_thinking_signature'
  | 'rate_limit'
  | 'transient_not_found'
  | 'model_not_found'
  | 'invalid_request'

export interface HiddenTurnError {
  kind: HiddenTurnErrorKind
  code:
    | 'QUOTA'
    | 'PROVIDER_ERROR'
    | 'RATE_LIMIT'
    | 'SERVER'
    | 'UNKNOWN_MODEL'
    | 'INVALID_REQUEST'
  message: string
  dirtySession?: boolean
  resetTimestamp?: string
  retryAfterSeconds?: number
}

/** Options for one merged `readSessionTurnData` query. */
export interface ReadSessionTurnDataOptions {
  metaFloorIdx: number | null
  turnMetaFloorIdx?: number | null
  lastStepIdx?: number | null
  checkStepsError?: boolean
  ifChangedSince?: string
  maxMetaRows?: number
}

/** Telemetry and optional hidden API error observed from one session DB read. */
export interface SessionTurnData {
  unchanged?: boolean
  stamp: string
  maxContextTokens?: number
  estimatedTokensUsed?: number
  hiddenError?: HiddenTurnError
}

function isValidSessionId(sessionId: string): boolean {
  return (
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    !/[^A-Za-z0-9._-]/.test(sessionId) &&
    sessionId !== '.' &&
    !sessionId.includes('..')
  )
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Remove named entries inside a non-symlinked directory.
 * Never follows a replaced parent directory into paths outside the isolated home.
 */
export function removeArtifacts(
  directory: string,
  names: readonly string[],
): void {
  if (!isRealDirectory(directory)) return
  for (const name of names) {
    try {
      rmSync(join(directory, name), { recursive: true, force: true })
    } catch {
      // Locked or unreadable leftovers can be retried on the next startup.
    }
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
    `${sessionId}.db-journal`,
  ])
  removeArtifacts(join(appData, 'brain'), [sessionId])
  removeArtifacts(join(appData, 'annotations'), [`${sessionId}.pbtxt`])
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

function lstatBigIntOrMissing(
  path: string,
): BigIntStats | 'missing' | 'invalid' {
  try {
    return lstatSync(path, { bigint: true })
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? 'missing'
      : 'invalid'
  }
}

/**
 * Validate a session's SQLite database path and sidecar files (`-wal`, `-shm`, `-journal`),
 * rejecting symlinks, non-regular files, and escapes outside `home`, and returning a
 * lightweight change stamp derived from the already-obtained `lstatSync` metadata.
 */
export function resolveSessionDbPath(
  home: string,
  sessionId: string,
): ResolvedSessionDb {
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
  const dbStat = lstatBigIntOrMissing(dbPath)
  if (dbStat === 'missing') return { kind: 'missing' }
  if (dbStat === 'invalid' || dbStat.isSymbolicLink() || !dbStat.isFile())
    return { kind: 'invalid' }

  let walStat: BigIntStats | undefined
  let journalStat: BigIntStats | undefined
  // Reject symlinked or non-regular SQLite sidecar files before opening.
  for (const suffix of ['-wal', '-shm', '-journal'] as const) {
    const sidecarStat = lstatBigIntOrMissing(`${dbPath}${suffix}`)
    if (sidecarStat === 'missing') continue
    if (
      sidecarStat === 'invalid' ||
      sidecarStat.isSymbolicLink() ||
      !sidecarStat.isFile()
    ) {
      return { kind: 'invalid' }
    }
    if (suffix === '-wal') walStat = sidecarStat
    else if (suffix === '-journal') journalStat = sidecarStat
  }

  const stamp = `${dbStat.mtimeNs}:${dbStat.size}|${walStat?.mtimeNs ?? 0n}:${walStat?.size ?? 0n}|${journalStat?.mtimeNs ?? 0n}:${journalStat?.size ?? 0n}`
  return { kind: 'ok', dbPath, stamp }
}

const DURATION_FULL_RE =
  /^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|[\u00b5\u03bc]s|ms|s|m|h))+$/
const DURATION_PART_RE = /(\d+(?:\.\d*)?|\.\d+)(ns|[\u00b5\u03bc]s|ms|s|m|h)/g

const DURATION_UNIT_SECONDS: Record<string, number> = {
  h: 3600,
  m: 60,
  s: 1,
  ms: 1e-3,
  '\u00b5s': 1e-6,
  '\u03bcs': 1e-6,
  ns: 1e-9,
}

/**
 * Parse a Go-style composite duration string (e.g. `32m51.529394773s`, `500ms`,
 * `250µs`, `250μs`, `1000ns`) into seconds, or `undefined` when malformed.
 */
export function parseDurationSeconds(raw: string): number | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0 || !DURATION_FULL_RE.test(trimmed)) return undefined
  let total = 0
  for (const match of trimmed.matchAll(DURATION_PART_RE)) {
    const amount = Number(match[1])
    const unit = DURATION_UNIT_SECONDS[match[2] as string]
    if (!Number.isFinite(amount) || unit === undefined) return undefined
    total += amount * unit
  }
  return Number.isFinite(total) ? total : undefined
}

function extractPayloadField(
  payload: string,
  field: string,
): string | undefined {
  const jsonMatch = new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`).exec(payload)
  if (jsonMatch?.[1] !== undefined) return jsonMatch[1]
  const protoQuoted = new RegExp(`\\b${field}\\s*:\\s*"([^"]+)"`).exec(payload)
  if (protoQuoted?.[1] !== undefined) return protoQuoted[1]
  const protoBare = new RegExp(`\\b${field}\\s*:\\s*([^\\s,}"]+)`).exec(payload)
  if (protoBare?.[1] !== undefined) return protoBare[1]
  return undefined
}

const QUOTA_EXHAUSTED_RE =
  /(?:"reason"\s*:\s*"QUOTA_EXHAUSTED"|\breason:QUOTA_EXHAUSTED\b)/
const INVALID_THINKING_SIG_RE =
  /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/
const RATE_LIMIT_RE =
  /(?:HTTP\s+429|\(code\s+429\)|"code"\s*:\s*429|\bRESOURCE_EXHAUSTED\b)/
const NOT_FOUND_RE =
  /(?:HTTP\s+404|\(code\s+404\)|"code"\s*:\s*404|\bNOT_FOUND\b)/
const INVALID_ARGUMENT_RE =
  /(?:HTTP\s+400|\(code\s+400\)|"code"\s*:\s*400|\bINVALID_ARGUMENT\b|Unable to process input image)/i

/**
 * Classify a terminal `steps` error payload (`step_type = 17`) into a structured
 * error for the runtime, or `undefined` for unclassified/transient payloads.
 */
export function classifyStepErrorPayload(
  payload: string,
  reachedModel: boolean,
): HiddenTurnError | undefined {
  if (typeof payload !== 'string' || payload.length === 0) return undefined

  if (QUOTA_EXHAUSTED_RE.test(payload)) {
    const resetTimestamp = extractPayloadField(payload, 'quotaResetTimeStamp')
    const rawDelay =
      extractPayloadField(payload, 'quotaResetDelay') ??
      extractPayloadField(payload, 'retryDelay')
    const parsedDelay =
      rawDelay !== undefined ? parseDurationSeconds(rawDelay) : undefined
    const retryAfterSeconds =
      parsedDelay !== undefined && parsedDelay > 0 ? parsedDelay : undefined
    const details: string[] = []
    if (resetTimestamp !== undefined)
      details.push(`resets at ${resetTimestamp}`)
    if (rawDelay !== undefined && retryAfterSeconds !== undefined)
      details.push(`retry in ${rawDelay}`)
    const suffix = details.length > 0 ? ` (${details.join(', ')})` : ''
    return {
      kind: 'quota',
      code: 'QUOTA',
      message: `Antigravity quota exceeded${suffix}`,
      ...(resetTimestamp !== undefined ? { resetTimestamp } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    }
  }

  if (INVALID_THINKING_SIG_RE.test(payload)) {
    return {
      kind: 'invalid_thinking_signature',
      code: 'PROVIDER_ERROR',
      dirtySession: true,
      message:
        'Antigravity rejected an invalid thinking signature; rebuilding session on the next turn',
    }
  }

  if (RATE_LIMIT_RE.test(payload)) {
    const rawDelay = extractPayloadField(payload, 'retryDelay')
    const parsedDelay =
      rawDelay !== undefined ? parseDurationSeconds(rawDelay) : undefined
    const retryAfterSeconds =
      parsedDelay !== undefined && parsedDelay > 0 ? parsedDelay : undefined
    const suffix =
      rawDelay !== undefined && retryAfterSeconds !== undefined
        ? ` (retry in ${rawDelay})`
        : ''
    return {
      kind: 'rate_limit',
      code: 'RATE_LIMIT',
      message: `Antigravity rate limit exceeded (429 RESOURCE_EXHAUSTED)${suffix}`,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    }
  }

  if (NOT_FOUND_RE.test(payload)) {
    if (reachedModel) {
      return {
        kind: 'transient_not_found',
        code: 'SERVER',
        message:
          'Antigravity upstream stream returned 404 after reaching the model',
      }
    }
    return {
      kind: 'model_not_found',
      code: 'UNKNOWN_MODEL',
      message: 'Antigravity model is unavailable (404 NOT_FOUND)',
    }
  }

  if (INVALID_ARGUMENT_RE.test(payload)) {
    const detail = /Unable to process input image/i.test(payload)
      ? ': Unable to process input image'
      : ''
    return {
      kind: 'invalid_request',
      code: 'INVALID_REQUEST',
      message: `Antigravity rejected the request (400 INVALID_ARGUMENT)${detail}`,
    }
  }

  return undefined
}

function presentTables(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('gen_metadata', 'steps')",
    )
    .all() as Array<{ name?: unknown }>
  const tables = new Set<string>()
  for (const row of rows) {
    if (typeof row.name === 'string') tables.add(row.name)
  }
  return tables
}

/**
 * Read both `gen_metadata` (`MAX(idx) + 1`, or `0`) and `steps` (`MAX(idx)`, or `-1`)
 * cursors in a single read-only SQLite open before starting a prompt segment.
 * Returns `null` when the session database path is invalid, symlinked, corrupt, or unreadable.
 */
export function readSessionCursors(
  home: string,
  sessionId: string,
): SessionCursors | null {
  const resolved = resolveSessionDbPath(home, sessionId)
  if (resolved.kind === 'missing') return { nextMetaIdx: 0, lastStepIdx: -1 }
  if (resolved.kind === 'invalid') return null
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(resolved.dbPath, { readOnly: true, timeout: 50 })
    const tables = presentTables(db)
    let nextMetaIdx = 0
    if (tables.has('gen_metadata')) {
      const row = db
        .prepare('SELECT MAX(idx) AS maxIdx FROM gen_metadata')
        .get() as { maxIdx?: unknown } | undefined
      if (row?.maxIdx !== null && row?.maxIdx !== undefined) {
        if (typeof row.maxIdx !== 'number' || !Number.isSafeInteger(row.maxIdx))
          return null
        const next = row.maxIdx + 1
        if (!Number.isSafeInteger(next)) return null
        nextMetaIdx = Math.max(0, next)
      }
    }
    let lastStepIdx = -1
    if (tables.has('steps')) {
      const row = db
        .prepare('SELECT MAX(idx) AS maxIdx FROM steps')
        .get() as { maxIdx?: unknown } | undefined
      if (row?.maxIdx !== null && row?.maxIdx !== undefined) {
        if (typeof row.maxIdx !== 'number' || !Number.isSafeInteger(row.maxIdx))
          return null
        lastStepIdx = row.maxIdx
      }
    }
    return { nextMetaIdx, lastStepIdx }
  } catch {
    return null
  } finally {
    db?.close()
  }
}

function validMetaFloor(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}

/**
 * Read bounded context-window metadata and (optionally) terminal hidden API errors
 * from one session's SQLite database in a single read-only open.
 * Skips opening SQLite completely when `ifChangedSince` matches the current file stamp.
 * Strictly fail-closed: any SQLite error returns `undefined`.
 */
export function readSessionTurnData(
  home: string,
  sessionId: string,
  options: ReadSessionTurnDataOptions,
): SessionTurnData | undefined {
  const resolved = resolveSessionDbPath(home, sessionId)
  if (resolved.kind !== 'ok') return undefined
  if (
    options.ifChangedSince !== undefined &&
    options.ifChangedSince === resolved.stamp
  ) {
    return { unchanged: true, stamp: resolved.stamp }
  }

  const metaFloor = validMetaFloor(options.metaFloorIdx)
  const turnFloor = validMetaFloor(options.turnMetaFloorIdx)
  const stepCursor =
    typeof options.lastStepIdx === 'number' &&
    Number.isSafeInteger(options.lastStepIdx) &&
    options.lastStepIdx >= -1
      ? options.lastStepIdx
      : null
  const limit =
    options.maxMetaRows === undefined
      ? DEFAULT_MAX_META_ROWS
      : Number.isSafeInteger(options.maxMetaRows) && options.maxMetaRows > 0
        ? options.maxMetaRows
        : 0

  const needMax = metaFloor !== null && limit > 0
  const needEst = turnFloor !== null && limit > 0
  const needSteps = options.checkStepsError === true && stepCursor !== null
  if (!needMax && !needEst && !needSteps) {
    return { stamp: resolved.stamp }
  }

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(resolved.dbPath, { readOnly: true, timeout: 50 })
    const tables = presentTables(db)

    let maxContextTokens: number | undefined
    let estimatedTokensUsed: number | undefined
    if ((needMax || needEst) && tables.has('gen_metadata')) {
      const minFloor =
        needMax && needEst
          ? Math.min(metaFloor, turnFloor)
          : needMax
            ? metaFloor
            : (turnFloor as number)
      const stmt = db.prepare(
        'SELECT idx, data FROM gen_metadata WHERE idx >= ? ORDER BY idx DESC LIMIT ?',
      )
      for (const row of stmt.iterate(minFloor, limit) as Iterable<{
        idx?: unknown
        data?: unknown
      }>) {
        if (typeof row.idx !== 'number' || !(row.data instanceof Uint8Array))
          continue
        const wantMaxHere =
          needMax && maxContextTokens === undefined && row.idx >= metaFloor
        const wantEstHere =
          needEst &&
          estimatedTokensUsed === undefined &&
          row.idx >= (turnFloor as number)
        if (!wantMaxHere && !wantEstHere) break
        const meta = extractContextWindowMetadata(row.data)
        if (meta === undefined) continue
        if (wantMaxHere && meta.maxContextTokens !== undefined)
          maxContextTokens = meta.maxContextTokens
        if (wantEstHere && meta.estimatedTokensUsed !== undefined)
          estimatedTokensUsed = meta.estimatedTokensUsed
        if (
          (!needMax || maxContextTokens !== undefined) &&
          (!needEst || estimatedTokensUsed !== undefined)
        ) {
          break
        }
      }
    }

    let hiddenError: HiddenTurnError | undefined
    if (needSteps && tables.has('steps')) {
      const latest = db
        .prepare(
          'SELECT step_type AS type, substr(step_payload, 1, 16384) AS payload FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1',
        )
        .get(stepCursor) as { type?: unknown; payload?: unknown } | undefined
      if (latest?.type === 17) {
        const reachedModel =
          db
            .prepare(
              'SELECT 1 FROM steps WHERE idx > ? AND step_type = 15 LIMIT 1',
            )
            .get(stepCursor) !== undefined
        const text =
          latest.payload instanceof Uint8Array
            ? Buffer.from(latest.payload).toString('utf8')
            : typeof latest.payload === 'string'
              ? latest.payload
              : ''
        hiddenError = classifyStepErrorPayload(text, reachedModel)
      }
    }

    return {
      stamp: resolved.stamp,
      ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
      ...(estimatedTokensUsed !== undefined ? { estimatedTokensUsed } : {}),
      ...(hiddenError !== undefined ? { hiddenError } : {}),
    }
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}
