import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const workflow = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
)

// Execute the workflow's actual shell blocks against local command substitutes.
function scriptFor(name) {
  const step = workflow
    .split('      - name: ')
    .find((block) => block.startsWith(`${name}\n`))
  assert.ok(step, `Missing workflow step: ${name}`)
  return step
    .split('        run: |\n')[1]
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n')
}

function fixture(t, version = '1.2.3') {
  const root = mkdtempSync(join(tmpdir(), 'pi-release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'bin'))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'pi-agy-acp', version }),
  )
  writeFileSync(
    join(root, 'bin', 'curl'),
    '#!/bin/sh\nprintf "curl\\n" >> "$CALLS_FILE"\nprintf "%s" "$HTTP_STATUS"\nexit "${CURL_EXIT:-0}"\n',
    { mode: 0o755 },
  )
  writeFileSync(
    join(root, 'bin', 'gh'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS_FILE"\ncase "$2" in\nview) exit "$VIEW_EXIT" ;;\ncreate) exit "$CREATE_EXIT" ;;\n*) exit 99 ;;\nesac\n',
    { mode: 0o755 },
  )
  return (name, env = {}) => {
    const output = join(root, 'output')
    const calls = join(root, 'calls')
    writeFileSync(output, '')
    writeFileSync(calls, '')
    const result = spawnSync(
      'bash',
      ['-e', '-o', 'pipefail', '-c', scriptFor(name)],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          GITHUB_OUTPUT: output,
          CALLS_FILE: calls,
          GITHUB_REF_TYPE: 'tag',
          GITHUB_REF_NAME: 'v1.2.3',
          HTTP_STATUS: '404',
          VIEW_EXIT: '0',
          CREATE_EXIT: '0',
          ...env,
        },
      },
    )
    assert.ifError(result.error)
    return {
      ...result,
      output: readFileSync(output, 'utf8'),
      calls: readFileSync(calls, 'utf8'),
    }
  }
}

test('release preflight rejects branch dispatch and tag mismatches before contacting npm', (t) => {
  const run = fixture(t)
  for (const env of [
    { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' },
    { GITHUB_REF_NAME: 'v9.9.9' },
  ]) {
    const result = run('Validate release tag and check npm registry', env)
    assert.notEqual(result.status, 0)
    assert.match(
      result.stdout,
      /Run this workflow on the existing v1\.2\.3 tag/,
    )
    assert.equal(result.output, '')
    assert.equal(result.calls, '')
  }
})

test('prerelease tags cannot accidentally publish to the stable channel', (t) => {
  const run = fixture(t, '1.2.3-rc.1')
  const result = run('Validate release tag and check npm registry', {
    GITHUB_REF_NAME: 'v1.2.3-rc.1',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /stable versions only/)
  assert.equal(result.calls, '')
  assert.equal(result.output, '')
})

test('only a registry 404 allows publication; outages and auth failures stop the release', (t) => {
  const run = fixture(t)
  for (const [status, expected] of [
    ['200', 'true'],
    ['404', 'false'],
  ]) {
    const result = run('Validate release tag and check npm registry', {
      HTTP_STATUS: status,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.output, `published=${expected}\n`)
  }
  for (const env of [
    { HTTP_STATUS: '401' },
    { HTTP_STATUS: '403' },
    { HTTP_STATUS: '429' },
    { HTTP_STATUS: '500' },
    { CURL_EXIT: '28', HTTP_STATUS: '000' },
  ]) {
    const result = run('Validate release tag and check npm registry', env)
    assert.notEqual(result.status, 0)
    assert.equal(result.output, '')
  }
})

test('release recovery reuses the existing tag and never creates a tag at the current commit', (t) => {
  const run = fixture(t)
  const existing = run('Ensure GitHub Release exists')
  assert.equal(existing.status, 0)
  assert.equal(existing.calls, 'release view v1.2.3\n')
  const recovered = run('Ensure GitHub Release exists', { VIEW_EXIT: '1' })
  assert.equal(recovered.status, 0)
  assert.equal(
    recovered.calls,
    'release view v1.2.3\nrelease create v1.2.3 --verify-tag --title v1.2.3 --generate-notes\n',
  )
  assert.notEqual(
    run('Ensure GitHub Release exists', { VIEW_EXIT: '1', CREATE_EXIT: '1' })
      .status,
    0,
  )
})

test('release-please tag handoff validates and checks GitHub Release on main push', (t) => {
  const run = fixture(t)
  const validated = run('Validate release tag and check npm registry', {
    GITHUB_REF_TYPE: 'branch',
    GITHUB_REF_NAME: 'main',
    RELEASE_TAG: 'v1.2.3',
  })
  assert.equal(validated.status, 0, validated.stderr)
  assert.equal(validated.output, 'published=false\n')

  const checked = run('Ensure GitHub Release exists', {
    GITHUB_REF_TYPE: 'branch',
    GITHUB_REF_NAME: 'main',
    RELEASE_TAG: 'v1.2.3',
  })
  assert.equal(checked.status, 0, checked.stderr)
  assert.equal(checked.calls, 'release view v1.2.3\n')
})
