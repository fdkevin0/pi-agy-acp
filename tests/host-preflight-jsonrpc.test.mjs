import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpProcess } from '../src/acp-process.ts'
import {
  buildAgyEnv,
  redactStderr,
  runCommand,
  spawnAcp,
  terminateProcessTree,
} from '../src/host.ts'
import { JsonRpcClosedError, JsonRpcPeer, MAX_LINE_CHARS } from '../src/jsonrpc.ts'
import {
  atomicWriteFile,
  isDefaultPiAgyHome,
  prepareHome,
  resolveAgyBinary,
  syncOAuthToken,
} from '../src/preflight.ts'
import { AntigravityRuntime } from '../src/runtime.ts'
import { defaults } from '../src/config.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
const fakeAgy = join(here, 'fake-agy.mjs')

function makeTempRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('isDefaultPiAgyHome matches normalized default path and rejects custom homes', (t) => {
  const userHome = makeTempRoot(t, 'pi-default-home-')
  const expected = join(userHome, '.pi', 'agent', 'cache', 'antigravity-acp')
  assert.equal(isDefaultPiAgyHome(expected, userHome), true)
  assert.equal(
    isDefaultPiAgyHome(join(expected, '..', 'antigravity-acp'), userHome),
    true,
  )
  assert.equal(isDefaultPiAgyHome(join(userHome, 'custom-home'), userHome), false)
  assert.equal(
    isDefaultPiAgyHome(expected.toUpperCase(), userHome, 'win32'),
    true,
  )
})

test('atomicWriteFile writes atomically and rejects symlink and directory targets', (t) => {
  const root = makeTempRoot(t, 'pi-atomic-')
  const target = join(root, 'data.txt')
  atomicWriteFile(target, 'hello-world', { mode: 0o600 })
  assert.equal(readFileSync(target, 'utf8'), 'hello-world')
  assert.deepEqual(
    readdirSync(root).filter((name) => name.endsWith('.tmp')),
    [],
  )

  const outside = join(root, 'outside.txt')
  writeFileSync(outside, 'original')
  const linkPath = join(root, 'link.txt')
  symlinkSync(outside, linkPath)
  assert.throws(() => atomicWriteFile(linkPath, 'hijacked'), /symlink|non-regular/i)
  assert.equal(readFileSync(outside, 'utf8'), 'original')

  const dirPath = join(root, 'subdir')
  mkdirSync(dirPath)
  assert.throws(() => atomicWriteFile(dirPath, 'hijacked'), /symlink|non-regular/i)
})

test(
  'atomicWriteFile applies 0o600 permissions on POSIX',
  { skip: process.platform === 'win32' },
  (t) => {
    const root = makeTempRoot(t, 'pi-atomic-mode-')
    const target = join(root, 'secret')
    atomicWriteFile(target, 'secret-token', { mode: 0o600 })
    assert.equal(statSync(target).mode & 0o777, 0o600)
  },
)

test('syncOAuthToken enforces custom PI_AGY_HOME isolation, skips symlinked/same-file sources, and rejects symlinked targets', (t) => {
  const root = makeTempRoot(t, 'pi-oauth-sync-')
  const userHome = join(root, 'user')
  const defaultPiHome = join(userHome, '.pi', 'agent', 'cache', 'antigravity-acp')
  const customPiHome = join(root, 'custom-pi-home')
  const cliDir = join(userHome, '.gemini', 'antigravity-cli')
  const envCliDir = join(root, 'env-cli')
  const envAgyDir = join(root, 'env-agy')
  mkdirSync(cliDir, { recursive: true })
  mkdirSync(envCliDir, { recursive: true })
  mkdirSync(envAgyDir, { recursive: true })

  // 1. Custom PI_AGY_HOME stays isolated and never copies from defaultAgyHomes.
  writeFileSync(join(cliDir, 'antigravity-oauth-token'), 'global-token')
  syncOAuthToken(customPiHome, userHome, {})
  assert.equal(existsSync(join(customPiHome, 'agy', 'antigravity-oauth-token')), false)

  // 2. Symlinked source token is skipped; falls back to next regular file.
  const secretFile = join(root, 'outside-secret')
  writeFileSync(secretFile, 'do-not-copy')
  symlinkSync(secretFile, join(envCliDir, 'antigravity-oauth-token'))
  writeFileSync(join(envAgyDir, 'antigravity-oauth-token'), 'regular-agy-token')
  syncOAuthToken(defaultPiHome, userHome, {
    ANTIGRAVITY_CLI_HOME: envCliDir,
    AGY_HOME: envAgyDir,
  })
  const dstToken = join(defaultPiHome, 'agy', 'antigravity-oauth-token')
  assert.equal(readFileSync(dstToken, 'utf8'), 'regular-agy-token')
  assert.deepEqual(
    readdirSync(join(defaultPiHome, 'agy')).filter((name) => name.endsWith('.tmp')),
    [],
  )

  // 3. Same-file path (ANTIGRAVITY_CLI_HOME === join(defaultPiHome, 'agy')) is a no-op.
  const beforeIno = statSync(dstToken, { bigint: true }).ino
  syncOAuthToken(defaultPiHome, userHome, {
    ANTIGRAVITY_CLI_HOME: join(defaultPiHome, 'agy'),
  })
  assert.equal(statSync(dstToken, { bigint: true }).ino, beforeIno)

  // 4. Hardlink same-file (dev, ino) is also a no-op even if mtime matches or differs.
  const hardlinkDir = join(root, 'hardlink-cli')
  mkdirSync(hardlinkDir, { recursive: true })
  linkSync(dstToken, join(hardlinkDir, 'antigravity-oauth-token'))
  syncOAuthToken(defaultPiHome, userHome, { ANTIGRAVITY_CLI_HOME: hardlinkDir })
  assert.equal(statSync(dstToken, { bigint: true }).ino, beforeIno)

  // 5. Rejects symlinked dst token file.
  const userHome2 = join(root, 'user2')
  const defaultPiHome2 = join(userHome2, '.pi', 'agent', 'cache', 'antigravity-acp')
  mkdirSync(join(defaultPiHome2, 'agy'), { recursive: true })
  const decoyTarget = join(root, 'decoy-dst')
  writeFileSync(decoyTarget, 'untouched')
  symlinkSync(decoyTarget, join(defaultPiHome2, 'agy', 'antigravity-oauth-token'))
  assert.throws(
    () => syncOAuthToken(defaultPiHome2, userHome2, { ANTIGRAVITY_CLI_HOME: envAgyDir }),
    /symlink|non-regular/i,
  )
  assert.equal(readFileSync(decoyTarget, 'utf8'), 'untouched')

  // 6. Rejects symlinked appData (home/agy).
  const userHome3 = join(root, 'user3')
  const defaultPiHome3 = join(userHome3, '.pi', 'agent', 'cache', 'antigravity-acp')
  mkdirSync(defaultPiHome3, { recursive: true })
  const decoyAppData = join(root, 'decoy-appdata')
  mkdirSync(decoyAppData, { recursive: true })
  symlinkSync(decoyAppData, join(defaultPiHome3, 'agy'), 'junction')
  assert.throws(
    () => syncOAuthToken(defaultPiHome3, userHome3, { ANTIGRAVITY_CLI_HOME: envAgyDir }),
    /symlink|non-directory/i,
  )
  assert.equal(existsSync(join(decoyAppData, 'antigravity-oauth-token')), false)
})

test(
  'syncOAuthToken writes token with 0o600 permissions on POSIX',
  { skip: process.platform === 'win32' },
  (t) => {
    const root = makeTempRoot(t, 'pi-oauth-mode-')
    const userHome = join(root, 'user')
    const defaultPiHome = join(userHome, '.pi', 'agent', 'cache', 'antigravity-acp')
    const cliDir = join(userHome, '.gemini', 'antigravity-cli')
    mkdirSync(cliDir, { recursive: true })
    const src = join(cliDir, 'antigravity-oauth-token')
    writeFileSync(src, 'mode-check-token', { mode: 0o644 })
    utimesSync(src, 1_700_000_500, 1_700_000_500)
    syncOAuthToken(defaultPiHome, userHome, {})
    const dst = join(defaultPiHome, 'agy', 'antigravity-oauth-token')
    assert.equal(statSync(dst).mode & 0o777, 0o600)
  },
)

test('prepareHome rejects symlinked settings.json, writes atomically, and warns instead of throwing on OAuth sync failure', (t) => {
  const root = makeTempRoot(t, 'pi-prepare-home-')
  const userHome = join(root, 'user')
  const defaultPiHome = join(userHome, '.pi', 'agent', 'cache', 'antigravity-acp')
  mkdirSync(join(defaultPiHome, 'agy'), { recursive: true })

  // 1. Symlinked OAuth token warns via onWarn and does not abort prepareHome.
  const decoyToken = join(root, 'decoy-token')
  writeFileSync(decoyToken, 'keep')
  symlinkSync(decoyToken, join(defaultPiHome, 'agy', 'antigravity-oauth-token'))
  const warnings = []
  const workspace = prepareHome(defaultPiHome, userHome, {}, (msg) =>
    warnings.push(msg),
  )
  assert.equal(existsSync(workspace), true)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /OAuth token sync/i)
  assert.equal(readFileSync(decoyToken, 'utf8'), 'keep')
  assert.deepEqual(
    readdirSync(join(defaultPiHome, 'agy')).filter((name) => name.endsWith('.tmp')),
    [],
  )

  // 2. Symlinked settings.json is rejected even when its target already matches desired JSON.
  const home2 = join(root, 'home2')
  mkdirSync(join(home2, 'agy'), { recursive: true })
  const decoySettings = join(root, 'decoy-settings.json')
  writeFileSync(
    decoySettings,
    `${JSON.stringify({ toolPermission: 'request-review', agentMode: '' }, null, 2)}\n`,
  )
  symlinkSync(decoySettings, join(home2, 'agy', 'settings.json'))
  assert.throws(
    () => prepareHome(home2, userHome, {}),
    /symlink|non-regular/i,
  )

  // 3. Symlinked parent directory home/agy is rejected and settings.json is never written outside.
  const home3 = join(root, 'home3')
  mkdirSync(home3, { recursive: true })
  const externalAgy = join(root, 'external-agy-dir')
  mkdirSync(externalAgy, { recursive: true })
  symlinkSync(externalAgy, join(home3, 'agy'), 'junction')
  assert.throws(
    () => prepareHome(home3, userHome, {}),
    /symlink|non-directory/i,
  )
  assert.equal(existsSync(join(externalAgy, 'settings.json')), false)

  // 4. Symlinked parent directory home/config is rejected before writing bridge plugin files.
  const home4 = join(root, 'home4')
  mkdirSync(home4, { recursive: true })
  const externalConfig = join(root, 'external-config-dir')
  mkdirSync(externalConfig, { recursive: true })
  symlinkSync(externalConfig, join(home4, 'config'), 'junction')
  assert.throws(
    () => prepareHome(home4, userHome, {}),
    /symlink|non-directory/i,
  )
  assert.equal(existsSync(join(externalConfig, 'plugins')), false)
})

test('runtime warns instead of failing openSession when OAuth token sync fails', async (t) => {
  const root = makeTempRoot(t, 'pi-runtime-oauth-warn-')
  const defaultPiHome = join(root, '.pi', 'agent', 'cache', 'antigravity-acp')
  mkdirSync(join(defaultPiHome, 'agy'), { recursive: true })
  const decoyToken = join(root, 'decoy-token')
  writeFileSync(decoyToken, 'untouched')
  symlinkSync(decoyToken, join(defaultPiHome, 'agy', 'antigravity-oauth-token'))

  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE
  const prevCliHome = process.env.ANTIGRAVITY_CLI_HOME
  const prevAgyHome = process.env.AGY_HOME
  process.env.HOME = root
  process.env.USERPROFILE = root
  delete process.env.ANTIGRAVITY_CLI_HOME
  delete process.env.AGY_HOME
  t.after(() => {
    delete process.env.HOME
    delete process.env.USERPROFILE
    delete process.env.ANTIGRAVITY_CLI_HOME
    delete process.env.AGY_HOME
    Object.assign(
      process.env,
      ...[prevHome].filter((v) => v !== undefined).map((v) => ({ HOME: v })),
      ...[prevUserProfile]
        .filter((v) => v !== undefined)
        .map((v) => ({ USERPROFILE: v })),
      ...[prevCliHome]
        .filter((v) => v !== undefined)
        .map((v) => ({ ANTIGRAVITY_CLI_HOME: v })),
      ...[prevAgyHome]
        .filter((v) => v !== undefined)
        .map((v) => ({ AGY_HOME: v })),
    )
  })

  const warnings = []
  const runtime = new AntigravityRuntime({
    config: { ...defaults, command: fakeAgy, home: defaultPiHome },
    spawnAcp: (argv, cwd) => spawnAcp([process.execPath, ...argv], cwd),
    runCommand: async () => ({ code: 0, stdout: '1.5.18', stderr: '' }),
    log: {
      info() {},
      warn(msg) {
        warnings.push(msg)
      },
    },
    onModelsChanged() {},
  })
  t.after(() => runtime.dispose())

  const chunks = await Array.fromAsync(
    runtime.stream({
      model: 'gemini-4-argon',
      sessionId: 'oauth-warn-session',
      messages: [
        { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ],
    }),
  )
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(chunks.at(-1)?.reason.kind, 'stop')
  assert.ok(
    warnings.filter((w) => /OAuth token sync/i.test(w)).length >= 2,
    'expected warnings from both prepareHome and openSession',
  )
})

test('resolveAgyBinary supports case-insensitive PATH and Windows PATHEXT (.cmd/.bat/.exe)', (t) => {
  const root = makeTempRoot(t, 'pi-win-pathext-')
  const cmdDir = join(root, 'cmd-bin')
  const batDir = join(root, 'bat-bin')
  const exeDir = join(root, 'exe-bin')
  mkdirSync(cmdDir, { recursive: true })
  mkdirSync(batDir, { recursive: true })
  mkdirSync(exeDir, { recursive: true })

  const agyCmd = join(cmdDir, 'agy.cmd')
  const agyBat = join(batDir, 'agy.bat')
  const agyExe = join(exeDir, 'agy.exe')
  writeFileSync(agyCmd, '@echo off\r\n')
  writeFileSync(agyBat, '@echo off\r\n')
  writeFileSync(agyExe, 'MZ')

  // Lowercase `path` and default PATHEXT resolves .cmd when no .exe exists.
  assert.equal(
    resolveAgyBinary('', {
      platform: 'win32',
      home: root,
      env: { path: cmdDir },
    }),
    agyCmd,
  )

  // Case-insensitive `pathext` resolves .bat before .cmd when ordered first.
  const bothDir = join(root, 'both-bin')
  mkdirSync(bothDir, { recursive: true })
  writeFileSync(join(bothDir, 'agy.cmd'), '@echo off\r\n')
  writeFileSync(join(bothDir, 'agy.bat'), '@echo off\r\n')
  assert.equal(
    resolveAgyBinary('', {
      platform: 'win32',
      home: root,
      env: { Path: bothDir, pathext: '.BAT;.CMD' },
    }),
    join(bothDir, 'agy.bat'),
  )

  // Custom PATHEXT without .EXE still includes .exe and prefers .exe.
  assert.equal(
    resolveAgyBinary('', {
      platform: 'win32',
      home: root,
      env: { Path: `${cmdDir};${exeDir}`, PATHEXT: '.CMD' },
    }),
    agyExe,
  )
})

test(
  'resolveAgyBinary skips non-executable POSIX files and honors case-insensitive PATH',
  { skip: process.platform === 'win32' },
  (t) => {
    const root = makeTempRoot(t, 'pi-posix-xok-')
    const nonExecDir = join(root, 'non-exec')
    const execDir = join(root, 'exec')
    mkdirSync(nonExecDir, { recursive: true })
    mkdirSync(execDir, { recursive: true })

    const nonExec = join(nonExecDir, 'agy')
    const execBin = join(execDir, 'agy')
    writeFileSync(nonExec, '#!/bin/sh\n', { mode: 0o644 })
    chmodSync(nonExec, 0o644)
    writeFileSync(execBin, '#!/bin/sh\n', { mode: 0o755 })
    chmodSync(execBin, 0o755)

    assert.equal(
      resolveAgyBinary('', {
        platform: 'linux',
        home: root,
        env: { path: `${nonExecDir}${delimiter}${execDir}` },
      }),
      execBin,
    )
    assert.throws(
      () => resolveAgyBinary(nonExec, { platform: 'linux' }),
      /not found/i,
    )
  },
)

test('buildAgyEnv strips sensitive/conflicting variables and injects required agy flags', () => {
  const unixEnv = buildAgyEnv(
    {
      PATH: '/usr/bin',
      TMPDIR: '/custom/tmp',
      GEMINI_API_KEY: 'secret-gemini',
      GOOGLE_API_KEY: 'secret-google',
      GEMINI_HOME: '/wrong/home',
      ELECTRON_RUN_AS_NODE: '1',
      CHROME_CRASHPAD_PIPE_NAME: 'pipe',
      AGY_CLI_DISABLE_AUTO_UPDATE: '0',
    },
    'linux',
  )
  assert.equal(unixEnv.PATH, '/usr/bin')
  assert.equal(unixEnv.TMPDIR, '/custom/tmp')
  assert.equal(unixEnv.GEMINI_API_KEY, undefined)
  assert.equal(unixEnv.GOOGLE_API_KEY, undefined)
  assert.equal(unixEnv.GEMINI_HOME, undefined)
  assert.equal(unixEnv.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(unixEnv.CHROME_CRASHPAD_PIPE_NAME, undefined)
  assert.equal(unixEnv.AGY_CLI_DISABLE_AUTO_UPDATE, '1')
  assert.equal(unixEnv.PYTHONUNBUFFERED, '1')

  const winEnv = buildAgyEnv(
    {
      Path: 'C:\\Windows',
      gemini_api_key: 'lower-secret',
      Google_Api_Key: 'mixed-secret',
      gemini_home: 'C:\\wrong',
      electron_run_as_node: '1',
      chrome_crashpad_pipe_name: 'pipe',
      agy_cli_disable_auto_update: '0',
      pythonunbuffered: '0',
    },
    'win32',
  )
  assert.equal(winEnv.Path, 'C:\\Windows')
  assert.equal(winEnv.gemini_api_key, undefined)
  assert.equal(winEnv.Google_Api_Key, undefined)
  assert.equal(winEnv.gemini_home, undefined)
  assert.equal(winEnv.electron_run_as_node, undefined)
  assert.equal(winEnv.chrome_crashpad_pipe_name, undefined)
  assert.equal(winEnv.agy_cli_disable_auto_update, undefined)
  assert.equal(winEnv.pythonunbuffered, undefined)
  assert.equal(winEnv.AGY_CLI_DISABLE_AUTO_UPDATE, '1')
  assert.equal(winEnv.PYTHONUNBUFFERED, '1')
})

test('redactStderr scrubs Bearer tokens, Google API keys, OAuth tokens, secret params, and accounts.google.com queries', () => {
  const raw = [
    'Authorization: Bearer secret-jwt-token.123',
    'Google key: AIzaSyD0123456789abcdefghijklm',
    'OAuth: ya29.a0AfH6SMC_super.secret-token',
    'Params: https://api.example/x?access_token=at123&refresh_token=rt456&id_token=id789&client_secret=cs000&api_key=ak111&key=k222&safe=ok',
    'Login: https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=xyz&code_challenge=123',
    'Plain: Authentication required. Please run agy to sign in.',
  ].join('\n')
  const redacted = redactStderr(raw)
  assert.doesNotMatch(redacted, /secret-jwt-token/)
  assert.doesNotMatch(redacted, /AIzaSyD0123456789/)
  assert.doesNotMatch(redacted, /ya29\.a0AfH6SMC/)
  assert.doesNotMatch(redacted, /at123|rt456|id789|cs000|ak111|k222/)
  assert.doesNotMatch(redacted, /code_challenge=123|state=xyz/)
  assert.match(redacted, /Authorization: Bearer \[REDACTED\]/)
  assert.match(redacted, /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?\[REDACTED\]/)
  assert.match(redacted, /safe=ok/)
  assert.match(redacted, /Authentication required\. Please run agy to sign in\./)
})

test('terminateProcessTree uses taskkill /T /F /PID on win32 and falls back to child.kill on error', () => {
  const spawnCalls = []
  const killer = new EventEmitter()
  let unrefCalled = false
  killer.unref = () => {
    unrefCalled = true
  }
  const killedSignals = []
  const fakeChild = {
    pid: 4242,
    kill(signal) {
      killedSignals.push(signal)
      return true
    },
  }

  terminateProcessTree(fakeChild, 'SIGTERM', {
    platform: 'win32',
    spawnTaskkill(command, args, options) {
      spawnCalls.push({ command, args, options })
      return killer
    },
  })

  assert.deepEqual(spawnCalls, [
    {
      command: 'taskkill',
      args: ['/T', '/F', '/PID', '4242'],
      options: { stdio: 'ignore', windowsHide: true },
    },
  ])
  assert.equal(unrefCalled, true)
  assert.deepEqual(killedSignals, [])

  killer.emit('error', new Error('ENOENT'))
  assert.deepEqual(killedSignals, ['SIGTERM'])
})

test('runCommand handles split UTF-8 stderr, large-chunk abortOnStderr, secret redaction, and inherited grandchild pipes', async (t) => {
  const root = makeTempRoot(t, 'pi-host-run-')

  // 1. Split multi-byte UTF-8 across stderr chunks + secret redaction + buildAgyEnv injection.
  const utf8Script = join(root, 'utf8-stderr.mjs')
  writeFileSync(
    utf8Script,
    `const bytes = Buffer.from('€🚀 Bearer top-secret-tok\\n', 'utf8')
process.stderr.write(bytes.subarray(0, 2))
setImmediate(() => {
  process.stderr.write(bytes.subarray(2, 5))
  setImmediate(() => {
    process.stderr.write(bytes.subarray(5))
    process.stdout.write(JSON.stringify({
      disableUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
      pyUnbuf: process.env.PYTHONUNBUFFERED,
      geminiKey: process.env.GEMINI_API_KEY ?? null,
    }))
  })
})
`,
  )
  const prevGeminiKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'should-be-stripped'
  t.after(() => {
    delete process.env.GEMINI_API_KEY
    Object.assign(
      process.env,
      ...[prevGeminiKey]
        .filter((v) => v !== undefined)
        .map((v) => ({ GEMINI_API_KEY: v })),
    )
  })
  const utf8Res = await runCommand([process.execPath, utf8Script], 5_000)
  assert.equal(utf8Res.code, 0)
  assert.equal(utf8Res.stderr, '€🚀 Bearer [REDACTED]\n')
  assert.deepEqual(JSON.parse(utf8Res.stdout), {
    disableUpdate: '1',
    pyUnbuf: '1',
    geminiKey: null,
  })

  // 2. abortOnStderr matches text at the front of a >64 KiB single chunk before tail slicing.
  const bigStderrScript = join(root, 'big-stderr.mjs')
  writeFileSync(
    bigStderrScript,
    `process.stderr.write('FRONT_ABORT_TOKEN ' + 'z'.repeat(80 * 1024) + '\\n')
setInterval(() => {}, 60000)
`,
  )
  const bigRes = await runCommand([process.execPath, bigStderrScript], 10_000, {
    abortOnStderr: /FRONT_ABORT_TOKEN/,
  })
  assert.equal(bigRes.abortedBy, 'stderr')

  // 3. Detached grandchild inheriting stdout/stderr pipe does not hang runCommand on parent exit.
  const gcPidFile = join(root, 'detached-gc.pid')
  const orphanParent = join(root, 'orphan-parent.mjs')
  writeFileSync(
    orphanParent,
    `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
  detached: true,
  stdio: ['ignore', 'inherit', 'inherit'],
})
writeFileSync(${JSON.stringify(gcPidFile)}, String(gc.pid))
gc.unref()
process.stdout.write('parent-done')
process.exit(0)
`,
  )
  t.after(() => {
    try {
      const pid = Number(readFileSync(gcPidFile, 'utf8').trim())
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already exited or not started.
    }
  })
  const orphanRes = await runCommand([process.execPath, orphanParent], 10_000)
  assert.equal(orphanRes.code, 0)
  assert.equal(orphanRes.stdout, 'parent-done')
  assert.equal(orphanRes.abortedBy, undefined)

  // 4. Detached grandchild inheriting stdout/stderr does not hang runCommand on abort either.
  const abortGcPidFile = join(root, 'abort-gc.pid')
  const abortParent = join(root, 'abort-parent.mjs')
  writeFileSync(
    abortParent,
    `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
  detached: true,
  stdio: ['ignore', 'inherit', 'inherit'],
})
writeFileSync(${JSON.stringify(abortGcPidFile)}, String(gc.pid))
gc.unref()
process.stderr.write('ABORT_NOW\\n')
setInterval(() => {}, 60000)
`,
  )
  t.after(() => {
    try {
      const pid = Number(readFileSync(abortGcPidFile, 'utf8').trim())
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already exited or not started.
    }
  })
  const abortOrphanRes = await runCommand(
    [process.execPath, abortParent],
    10_000,
    { abortOnStderr: /ABORT_NOW/ },
  )
  assert.equal(abortOrphanRes.abortedBy, 'stderr')
})

test('spawnAcp redacts stderrTail and decodes split multi-byte UTF-8', async (t) => {
  const root = makeTempRoot(t, 'pi-spawn-acp-')
  const script = join(root, 'acp-stderr.mjs')
  writeFileSync(
    script,
    `const bytes = Buffer.from('€ ya29.secret_oauth_val\\n', 'utf8')
process.stderr.write(bytes.subarray(0, 2))
setImmediate(() => {
  process.stderr.write(bytes.subarray(2))
  process.exit(0)
})
`,
  )
  const child = spawnAcp([process.execPath, script], root)
  await child.exited
  assert.equal(child.stderrTail(), '€ [REDACTED]\n')
})

test('JsonRpcPeer cursor parsing handles multi-line chunks, split remainders, and closes on >16 MiB frames', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const notifications = []
  const protocolErrors = []
  const closeErrors = []
  const peer = new JsonRpcPeer(input, output, {
    onRequest: async () => null,
    onNotification: (method, params) => notifications.push({ method, params }),
    onProtocolError: (detail) => protocolErrors.push(detail),
    onClose: (error) => closeErrors.push(error),
  })

  // Multiple frames in one chunk + partial frame remainder flattened across chunks.
  input.write(
    '{"jsonrpc":"2.0","method":"n1","params":{"v":1}}\n\n{"jsonrpc":"2.0","method":"n2","params":{"v":2}}\n{"jsonrpc":"2.0","meth',
  )
  input.write('od":"n3","params":{"v":3}}\n')
  assert.deepEqual(notifications, [
    { method: 'n1', params: { v: 1 } },
    { method: 'n2', params: { v: 2 } },
    { method: 'n3', params: { v: 3 } },
  ])

  // Frame exceeding 16 MiB (unterminated tail) closes the peer and rejects pending requests.
  const pending = peer.request('session/prompt', {})
  input.write('x'.repeat(MAX_LINE_CHARS + 1))
  await assert.rejects(pending, (err) => {
    assert.ok(err instanceof JsonRpcClosedError)
    assert.match(err.message, /16 MiB/)
    return true
  })
  assert.equal(peer.isClosed, true)
  assert.equal(protocolErrors.length, 1)
  assert.equal(closeErrors.length, 1)
  assert.ok(closeErrors[0] instanceof JsonRpcClosedError)

  // Terminated line exceeding 16 MiB also closes the peer immediately.
  const input2 = new PassThrough()
  const output2 = new PassThrough()
  const errors2 = []
  const peer2 = new JsonRpcPeer(input2, output2, {
    onRequest: async () => null,
    onNotification() {},
    onProtocolError: (detail) => errors2.push(detail),
  })
  const pending2 = peer2.request('initialize', {})
  input2.write(`${'a'.repeat(MAX_LINE_CHARS + 1)}\n{"jsonrpc":"2.0","id":1,"result":{}}\n`)
  await assert.rejects(pending2, /16 MiB/)
  assert.equal(peer2.isClosed, true)
  assert.equal(errors2.length, 1)
})

test('AcpProcess terminates child process when JsonRpcPeer self-closes on >16 MiB frame', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let terminateCalls = 0
  const exitErrors = []
  const logs = []
  const proc = new AcpProcess({
    argv: ['fake-agy', 'acp'],
    cwd: tmpdir(),
    clientName: 'pi-agy-acp',
    clientVersion: '0.2.1',
    log: (msg) => logs.push(msg),
    spawn: () => ({
      stdin,
      stdout,
      exited: new Promise(() => {}),
      terminate() {
        terminateCalls++
      },
      stderrTail: () => '',
    }),
  })
  proc.onExit((err) => exitErrors.push(err))
  const startPromise = proc.start(10_000)
  stdout.write('x'.repeat(MAX_LINE_CHARS + 1))
  await assert.rejects(startPromise, /16 MiB/)
  assert.equal(proc.alive, false)
  assert.equal(terminateCalls, 1)
  assert.equal(exitErrors.length, 1)
  assert.match(exitErrors[0].message, /16 MiB/)
  assert.equal(logs.length, 1)
})

test('index.ts writes warnings to stderr only when PI_AGY_DEBUG=1', async (t) => {
  const root = makeTempRoot(t, 'pi-debug-env-')
  const driver = join(root, 'driver.mjs')
  writeFileSync(
    driver,
    `import { PassThrough } from 'node:stream'
import extension from ${JSON.stringify(join(repoRoot, 'index.ts'))}

let provider
extension(
  {
    registerProvider(_name, def) { provider = def },
    registerCommand() {},
    on() {},
  },
  {
    runCommand: async () => ({ code: 0, stdout: '1.5.18', stderr: '' }),
    spawnAcp: () => {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      stdin.on('data', () => {
        stdout.write('not-valid-json\\n')
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }) + '\\n')
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 's1', configOptions: [] } }) + '\\n')
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 3, result: null }) + '\\n')
      })
      return {
        stdin,
        stdout,
        exited: new Promise(() => {}),
        terminate() {},
        stderrTail: () => '',
      }
    },
  },
)
await provider.refreshModels({ force: true })
process.exit(0)
`,
  )

  const runDriver = (label, extraEnv) =>
    new Promise((resolve, reject) => {
      const userHome = join(root, `user-${label}`)
      const piHome = join(root, `home-${label}`)
      mkdirSync(userHome, { recursive: true })
      const child = spawn(process.execPath, ['--no-warnings', driver], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: '',
          HOME: userHome,
          USERPROFILE: userHome,
          PI_AGY_HOME: piHome,
          PI_AGY_COMMAND: fakeAgy,
          ...extraEnv,
        },
      })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, stderr }))
    })

  const silentRes = await runDriver('off', {})
  assert.equal(silentRes.code, 0)
  assert.equal(silentRes.stderr, '')

  const debugRes = await runDriver('on', { PI_AGY_DEBUG: '1' })
  assert.equal(debugRes.code, 0)
  assert.match(debugRes.stderr, /\[pi-agy-acp\] acp: dropped frame: unparsable frame: not-valid-json/)
})

test('JsonRpcPeer.write ignores late async onRequest settlement after close', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  output.setEncoding('utf8')
  const written = []
  output.on('data', (chunk) => written.push(chunk))
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const peer = new JsonRpcPeer(input, output, {
    onRequest: async () => {
      entered.resolve()
      return gate.promise
    },
    onNotification() {},
  })

  input.write('{"jsonrpc":"2.0","id":7,"method":"ping","params":{}}\n')
  await entered.promise
  peer.close(new Error('shutdown'))
  gate.resolve({ ok: true })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(written, [])
})

test('AcpProcess guards malformed session/update and session/request_permission params', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdin.setEncoding('utf8')
  const replies = []
  const threeReplies = Promise.withResolvers()
  let buf = ''
  const onLine = (line) => {
    const msg = JSON.parse(line)
    replies.push(msg)
  }
  const updates = []
  const permissions = []
  const logs = []
  const proc = new AcpProcess({
    argv: ['fake-agy', 'acp'],
    cwd: tmpdir(),
    clientName: 'pi-agy-acp',
    clientVersion: '0.2.3',
    log: (msg) => logs.push(msg),
    spawn: () => ({
      stdin,
      stdout,
      exited: new Promise(() => {}),
      terminate() {},
      stderrTail: () => '',
    }),
  })
  stdin.on('data', (chunk) => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop()
    lines.filter(Boolean).forEach(onLine)
    const permissionReplies = replies.filter((m) => m.id === 10 || m.id === 11 || m.id === 12)
    permissionReplies.length === 3 && threeReplies.resolve()
  })

  const startPromise = proc.start(5_000)
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })}\n`)
  await startPromise

  const sessionPromise = proc.newSession(
    {},
    {
      onUpdate: (u) => updates.push(u),
      onPermission: (r) => {
        permissions.push(r)
        return { outcome: 'cancelled' }
      },
    },
    5_000,
  )
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 's1' } })}\n`)
  await sessionPromise

  stdout.write('{"jsonrpc":"2.0","method":"session/update","params":null}\n')
  stdout.write('{"jsonrpc":"2.0","method":"session/update","params":[]}\n')
  stdout.write('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":42,"update":{}}}\n')
  stdout.write('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":null}}\n')
  stdout.write('{"jsonrpc":"2.0","id":10,"method":"session/request_permission","params":null}\n')
  stdout.write('{"jsonrpc":"2.0","id":11,"method":"session/request_permission","params":[]}\n')
  stdout.write('{"jsonrpc":"2.0","id":12,"method":"session/request_permission","params":{"sessionId":123}}\n')

  await threeReplies.promise
  const byId = new Map(replies.map((m) => [m.id, m]))
  assert.deepEqual(byId.get(10)?.result, { outcome: { outcome: 'cancelled' } })
  assert.deepEqual(byId.get(11)?.result, { outcome: { outcome: 'cancelled' } })
  assert.deepEqual(byId.get(12)?.result, { outcome: { outcome: 'cancelled' } })
  assert.equal(updates.length, 0)
  assert.equal(permissions.length, 0)
  assert.deepEqual(logs, [])
  proc.stop()
})
