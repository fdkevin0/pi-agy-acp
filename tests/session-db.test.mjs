import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { prepareHome } from '../src/preflight.ts'
import {
  classifyStepErrorPayload,
  extractContextWindowMetadata,
  parseDurationSeconds,
  readSessionCursors,
  readSessionTurnData,
  removeSessionArtifacts,
  resolveSessionDbPath,
} from '../src/session-db.ts'

function makeTempHome(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-session-db-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function pbField(tagByte, payload) {
  return Uint8Array.from([tagByte, payload.length, ...payload])
}

function makeCtxBlob(maxVarintBytes, estVarintBytes = []) {
  const inner = Uint8Array.from([
    ...estVarintBytes,
    ...maxVarintBytes,
  ])
  return pbField(0x0a, pbField(0x4a, pbField(0x52, inner)))
}

const BLOB_512K = makeCtxBlob([0x20, 0x80, 0xa0, 0x1f])
const BLOB_128K = makeCtxBlob([0x20, 0x80, 0x80, 0x08])
const BLOB_BOTH = makeCtxBlob([0x20, 0x80, 0xa0, 0x1f], [0x08, 0xd2, 0x09])
const BLOB_ONLY_EST = makeCtxBlob([], [0x08, 0xd2, 0x09])
const BLOB_UNRELATED = Uint8Array.from([0x12, 0x01, 0x00])

test('parseDurationSeconds parses Go-style composite durations including micro signs and rejects invalid input', () => {
  assert.equal(parseDurationSeconds('32m51.529394773s'), 32 * 60 + 51.529394773)
  assert.equal(parseDurationSeconds('1971.5s'), 1971.5)
  assert.equal(parseDurationSeconds('500ms'), 0.5)
  assert.equal(parseDurationSeconds('250\u00b5s'), 0.00025)
  assert.equal(parseDurationSeconds('250\u03bcs'), 0.00025)
  assert.equal(parseDurationSeconds('1h2m3s'), 3723)
  assert.equal(parseDurationSeconds('1000000ns'), 0.001)
  assert.equal(parseDurationSeconds('0.25s'), 0.25)
  assert.equal(parseDurationSeconds(''), undefined)
  assert.equal(parseDurationSeconds('   '), undefined)
  assert.equal(parseDurationSeconds('abc'), undefined)
  assert.equal(parseDurationSeconds('5x'), undefined)
  assert.equal(parseDurationSeconds('-10s'), undefined)
})

test('classifyStepErrorPayload classifies QUOTA_EXHAUSTED in both JSON and proto-text formats', () => {
  const realJsonPayload = JSON.stringify({
    error: {
      code: 429,
      message: 'You have exhausted your capacity on this model.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'QUOTA_EXHAUSTED',
          metadata: {
            quotaResetTimeStamp: '2026-11-22T18:30:00Z',
            quotaResetDelay: '32m51.529394773s',
          },
        },
        {
          '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          retryDelay: '1971.5s',
        },
      ],
    },
  })
  const fromJson = classifyStepErrorPayload(realJsonPayload, false)
  assert.equal(fromJson?.kind, 'quota')
  assert.equal(fromJson?.code, 'QUOTA')
  assert.equal(fromJson?.resetTimestamp, '2026-11-22T18:30:00Z')
  assert.equal(fromJson?.retryAfterSeconds, 32 * 60 + 51.529394773)
  assert.match(fromJson?.message ?? '', /quota exceeded/i)
  assert.match(fromJson?.message ?? '', /2026-11-22T18:30:00Z/)

  const protoTextMicroSign =
    'details:{reason:QUOTA_EXHAUSTED metadata:{quotaResetTimeStamp:"2026-11-22T19:00:00Z" quotaResetDelay:"250\u00b5s"}}'
  const fromProto1 = classifyStepErrorPayload(protoTextMicroSign, false)
  assert.equal(fromProto1?.kind, 'quota')
  assert.equal(fromProto1?.code, 'QUOTA')
  assert.equal(fromProto1?.resetTimestamp, '2026-11-22T19:00:00Z')
  assert.equal(fromProto1?.retryAfterSeconds, 0.00025)

  const protoTextGreekMu =
    'details:{reason:QUOTA_EXHAUSTED retryDelay:250\u03bcs}'
  const fromProto2 = classifyStepErrorPayload(protoTextGreekMu, false)
  assert.equal(fromProto2?.kind, 'quota')
  assert.equal(fromProto2?.code, 'QUOTA')
  assert.equal(fromProto2?.retryAfterSeconds, 0.00025)
})

test('classifyStepErrorPayload classifies both INVALID_THINKING_SIGNATURE variants and marks dirtySession', () => {
  const variant1 =
    'HTTP 400: messages.3.content.0.thinking.signature: Field required'
  assert.deepEqual(classifyStepErrorPayload(variant1, false), {
    kind: 'invalid_thinking_signature',
    code: 'PROVIDER_ERROR',
    dirtySession: true,
    message:
      'Antigravity rejected an invalid thinking signature; rebuilding session on the next turn',
  })

  const variant2 =
    'Bad request: messages.12.content.4: Invalid `signature` in `thinking` block'
  assert.deepEqual(classifyStepErrorPayload(variant2, true), {
    kind: 'invalid_thinking_signature',
    code: 'PROVIDER_ERROR',
    dirtySession: true,
    message:
      'Antigravity rejected an invalid thinking signature; rebuilding session on the next turn',
  })
})

test('classifyStepErrorPayload classifies structured 429/RESOURCE_EXHAUSTED and 404/NOT_FOUND without false positives on bare numbers', () => {
  const rateJson = '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","retryDelay":"12.5s"}}'
  const rateRes = classifyStepErrorPayload(rateJson, false)
  assert.equal(rateRes?.kind, 'rate_limit')
  assert.equal(rateRes?.code, 'RATE_LIMIT')
  assert.equal(rateRes?.retryAfterSeconds, 12.5)

  assert.equal(
    classifyStepErrorPayload('upstream failed: HTTP 429 Too Many Requests', false)?.kind,
    'rate_limit',
  )
  assert.equal(
    classifyStepErrorPayload('request rejected (code 429)', false)?.kind,
    'rate_limit',
  )

  assert.deepEqual(
    classifyStepErrorPayload('upstream failed: HTTP 404 NOT_FOUND', false),
    {
      kind: 'model_not_found',
      code: 'UNKNOWN_MODEL',
      message: 'Antigravity model is unavailable (404 NOT_FOUND)',
    },
  )
  assert.deepEqual(
    classifyStepErrorPayload('{"code": 404, "message": "stream gone"}', true),
    {
      kind: 'transient_not_found',
      code: 'SERVER',
      message:
        'Antigravity upstream stream returned 404 after reaching the model',
    },
  )
  assert.equal(
    classifyStepErrorPayload('upstream error (code 404)', true)?.kind,
    'transient_not_found',
  )

  // Bare 404 / 429 in UUIDs, trace IDs, or transient EOF messages must NOT match.
  assert.equal(
    classifyStepErrorPayload(
      'API error (attempt 1): request failed: EOF trace_id=550e8400-e29b-404d-a429-446655440000',
      false,
    ),
    undefined,
  )
  assert.equal(
    classifyStepErrorPayload('request_id=req_429_404_ok internal error', true),
    undefined,
  )
  assert.equal(classifyStepErrorPayload('', false), undefined)
})

test('readSessionCursors and readSessionTurnData handle missing DBs, idx=0 steps, BLOB/TEXT payloads, and stamp gating', (t) => {
  const home = makeTempHome(t)
  assert.deepEqual(readSessionCursors(home, 'missing'), {
    nextMetaIdx: 0,
    lastStepIdx: -1,
  })
  assert.equal(
    readSessionTurnData(home, 'missing', { metaFloorIdx: 0 }),
    undefined,
  )

  const convDir = join(home, 'agy', 'conversations')
  mkdirSync(convDir, { recursive: true })
  const dbPath = join(convDir, 'sess-1.db')
  const db = new DatabaseSync(dbPath)
  t.after(() => db.close())
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob);
    CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL, step_payload blob);
  `)

  // Empty tables yield initial cursors (nextMetaIdx = 0, lastStepIdx = -1).
  assert.deepEqual(readSessionCursors(home, 'sess-1'), {
    nextMetaIdx: 0,
    lastStepIdx: -1,
  })

  // Step at idx = 0 (TEXT payload) must be caught when lastStepIdx = -1.
  db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, BLOB_BOTH)
  db.prepare(
    'INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)',
  ).run(0, 17, '{"reason":"QUOTA_EXHAUSTED","quotaResetDelay":"500ms"}')

  const first = readSessionTurnData(home, 'sess-1', {
    metaFloorIdx: 0,
    turnMetaFloorIdx: 0,
    lastStepIdx: -1,
    checkStepsError: true,
  })
  assert.equal(first?.maxContextTokens, 512_000)
  assert.equal(first?.estimatedTokensUsed, 1234)
  assert.equal(first?.hiddenError?.kind, 'quota')
  assert.equal(first?.hiddenError?.retryAfterSeconds, 0.5)
  assert.equal(typeof first?.stamp, 'string')

  // Unchanged stamp skips opening SQLite and returns { unchanged: true, stamp }.
  const gated = readSessionTurnData(home, 'sess-1', {
    metaFloorIdx: 0,
    turnMetaFloorIdx: 0,
    ifChangedSince: first.stamp,
  })
  assert.deepEqual(gated, { unchanged: true, stamp: first.stamp })

  // Proof that stamp gate skips opening SQLite even on an unreadable/corrupt file.
  const corruptPath = join(convDir, 'corrupt-gated.db')
  writeFileSync(corruptPath, 'not-a-sqlite-file')
  const corruptResolved = resolveSessionDbPath(home, 'corrupt-gated')
  assert.equal(corruptResolved.kind, 'ok')
  assert.deepEqual(
    readSessionTurnData(home, 'corrupt-gated', {
      metaFloorIdx: 0,
      ifChangedSince: corruptResolved.stamp,
    }),
    { unchanged: true, stamp: corruptResolved.stamp },
  )
  assert.equal(
    readSessionTurnData(home, 'corrupt-gated', { metaFloorIdx: 0 }),
    undefined,
  )

  // Subsequent writes advance cursors and test BLOB payload + reachedModel distinction.
  assert.deepEqual(readSessionCursors(home, 'sess-1'), {
    nextMetaIdx: 1,
    lastStepIdx: 0,
  })
  db.prepare(
    'INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)',
  ).run(1, 15, Buffer.from('model output', 'utf8'))
  db.prepare(
    'INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)',
  ).run(2, 17, Buffer.from('upstream HTTP 404 NOT_FOUND', 'utf8'))

  const afterModel = readSessionTurnData(home, 'sess-1', {
    metaFloorIdx: 0,
    lastStepIdx: 0,
    checkStepsError: true,
  })
  assert.equal(afterModel?.hiddenError?.kind, 'transient_not_found')
  assert.equal(afterModel?.hiddenError?.code, 'SERVER')

  // Retried step_type = 17 followed by step_type = 15 yields no hiddenError.
  db.prepare(
    'INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)',
  ).run(3, 15, Buffer.from('recovered reply', 'utf8'))
  const recovered = readSessionTurnData(home, 'sess-1', {
    metaFloorIdx: 0,
    lastStepIdx: 0,
    checkStepsError: true,
  })
  assert.equal(recovered?.hiddenError, undefined)
})

test('readSessionTurnData bounds gen_metadata scan with LIMIT and resolves dual floors in one pass', (t) => {
  const home = makeTempHome(t)
  const convDir = join(home, 'agy', 'conversations')
  mkdirSync(convDir, { recursive: true })
  const db = new DatabaseSync(join(convDir, 'bounded.db'))
  t.after(() => db.close())
  db.exec('CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob);')
  const insert = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)')

  // Row 1 holds maxContextTokens; rows 2..70 are unrelated; row 70 is outside default 64-row lookback from row 1.
  insert.run(1, BLOB_128K)
  Array.from({ length: 69 }, (_, i) => i + 2).forEach((idx) => {
    insert.run(idx, BLOB_UNRELATED)
  })

  const boundedDefault = readSessionTurnData(home, 'bounded', {
    metaFloorIdx: 0,
  })
  assert.equal(boundedDefault?.maxContextTokens, undefined)

  const boundedWide = readSessionTurnData(home, 'bounded', {
    metaFloorIdx: 0,
    maxMetaRows: 70,
  })
  assert.equal(boundedWide?.maxContextTokens, 131_072)

  // Dual floors: row 71 has maxContextTokens (for modelFloor=71), row 72 has only estimatedTokensUsed (for turnFloor=72).
  insert.run(71, BLOB_512K)
  insert.run(72, BLOB_ONLY_EST)
  const dual = readSessionTurnData(home, 'bounded', {
    metaFloorIdx: 71,
    turnMetaFloorIdx: 72,
  })
  assert.equal(dual?.maxContextTokens, 512_000)
  assert.equal(dual?.estimatedTokensUsed, 1234)
})

test('resolveSessionDbPath rejects -journal symlinks/dirs and artifact cleanup handles -journal and annotations', (t) => {
  const home = makeTempHome(t)
  const convDir = join(home, 'agy', 'conversations')
  const outside = join(home, 'outside')
  mkdirSync(convDir, { recursive: true })
  mkdirSync(outside, { recursive: true })

  const seedDb = (name) => {
    const db = new DatabaseSync(join(convDir, `${name}.db`))
    db.exec('CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob);')
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, BLOB_512K)
    db.close()
  }

  seedDb('sym-journal')
  const extJournal = join(outside, 'ext.db-journal')
  writeFileSync(extJournal, '')
  symlinkSync(extJournal, join(convDir, 'sym-journal.db-journal'))
  assert.equal(resolveSessionDbPath(home, 'sym-journal').kind, 'invalid')
  assert.equal(readSessionCursors(home, 'sym-journal'), null)
  assert.equal(
    readSessionTurnData(home, 'sym-journal', { metaFloorIdx: 0 }),
    undefined,
  )

  seedDb('dir-journal')
  mkdirSync(join(convDir, 'dir-journal.db-journal'))
  assert.equal(resolveSessionDbPath(home, 'dir-journal').kind, 'invalid')
  assert.equal(readSessionCursors(home, 'dir-journal'), null)

  // removeSessionArtifacts cleans -journal and annotations/<sessionId>.pbtxt, scoped to sessionId.
  const targetFiles = [
    'agy/conversations/clean-me.db',
    'agy/conversations/clean-me.db-wal',
    'agy/conversations/clean-me.db-shm',
    'agy/conversations/clean-me.db-journal',
    'agy/brain/clean-me/note.md',
    'agy/annotations/clean-me.pbtxt',
  ]
  const keepFiles = [
    'agy/conversations/keep-me.db-journal',
    'agy/annotations/keep-me.pbtxt',
  ]
  ;[...targetFiles, ...keepFiles].forEach((rel) => {
    const full = join(home, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, rel)
  })
  removeSessionArtifacts(home, 'clean-me')
  targetFiles.forEach((rel) => {
    assert.equal(existsSync(join(home, rel)), false, rel)
  })
  keepFiles.forEach((rel) => {
    assert.equal(existsSync(join(home, rel)), true, rel)
  })

  // Symlinked annotations directory must never be traversed.
  const extAnnotations = join(home, 'ext-annotations')
  mkdirSync(extAnnotations, { recursive: true })
  writeFileSync(join(extAnnotations, 'linked.pbtxt'), 'keep')
  rmSync(join(home, 'agy', 'annotations'), { recursive: true, force: true })
  symlinkSync(extAnnotations, join(home, 'agy', 'annotations'), 'junction')
  removeSessionArtifacts(home, 'linked')
  assert.equal(readFileSync(join(extAnnotations, 'linked.pbtxt'), 'utf8'), 'keep')

  // prepareHome cleans annotations and conversation_summaries.db-journal on startup.
  rmSync(join(home, 'agy', 'annotations'), { recursive: true, force: true })
  mkdirSync(join(home, 'agy', 'annotations'), { recursive: true })
  writeFileSync(join(home, 'agy', 'annotations', 'stale.pbtxt'), 'stale')
  writeFileSync(join(home, 'agy', 'conversation_summaries.db-journal'), 'stale')
  prepareHome(home, join(home, 'no-user-auth'))
  assert.equal(existsSync(join(home, 'agy', 'annotations', 'stale.pbtxt')), false)
  assert.equal(
    existsSync(join(home, 'agy', 'conversation_summaries.db-journal')),
    false,
  )
  assert.equal(extractContextWindowMetadata(BLOB_512K)?.maxContextTokens, 512_000)
})
