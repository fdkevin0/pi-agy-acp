import { spawn, type ChildProcess } from 'node:child_process'
import type { AcpSpawner } from './acp-process.ts'
import type { CommandOptions, CommandOutput, CommandRunner } from './preflight.ts'

const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_STDERR_TAIL_CHARS = 65_536
const EXIT_DRAIN_MS = 250
const SIGKILL_SETTLE_MS = 500

const STRIPPED_AGY_ENV_KEYS = new Set([
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_HOME',
  'ELECTRON_RUN_AS_NODE',
  'CHROME_CRASHPAD_PIPE_NAME',
])
const STRIPPED_AGY_ENV_KEYS_LOWER = new Set(
  [...STRIPPED_AGY_ENV_KEYS].map((key) => key.toLowerCase()),
)
const FORCED_AGY_ENV_KEYS_LOWER = new Set([
  'agy_cli_disable_auto_update',
  'pythonunbuffered',
])

/** Build a sanitized environment for spawning `agy` subprocesses. */
export function buildAgyEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const caseInsensitive = platform === 'win32'
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue
    if (caseInsensitive) {
      const lower = key.toLowerCase()
      if (
        STRIPPED_AGY_ENV_KEYS_LOWER.has(lower) ||
        FORCED_AGY_ENV_KEYS_LOWER.has(lower)
      )
        continue
    } else if (STRIPPED_AGY_ENV_KEYS.has(key)) {
      continue
    }
    env[key] = value
  }
  env.AGY_CLI_DISABLE_AUTO_UPDATE = '1'
  env.PYTHONUNBUFFERED = '1'
  return env
}

/** Scrub bearer tokens, Google API/OAuth tokens, secret params, and Google OAuth URL queries from stderr. */
export function redactStderr(text: string): string {
  return text
    .replace(
      /(https:\/\/accounts\.google\.com(?:\/[^\s"'?]*)?)\?[^\s"']+/gi,
      '$1?[REDACTED]',
    )
    .replace(/\bBearer\s+[^\s"'`]+/gi, 'Bearer [REDACTED]')
    .replace(/ya29\.[0-9A-Za-z._-]+/g, '[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
    .replace(
      /\b(access_token|refresh_token|id_token|client_secret|api_key|key)=[^&\s"']+/gi,
      '$1=[REDACTED]',
    )
}

/** Optional boundary seams for deterministic process-tree termination tests. */
export interface TerminateProcessOptions {
  platform?: NodeJS.Platform
  spawnTaskkill?: (
    command: string,
    args: readonly string[],
    options: { stdio: 'ignore'; windowsHide: true },
  ) => Pick<ChildProcess, 'unref' | 'once'>
  killGroup?: (pid: number, signal: NodeJS.Signals) => void
}

/** Terminate a spawned process and its process tree on Unix (`-pid`) and Windows (`taskkill /T /F /PID`). */
export function terminateProcessTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  signal: NodeJS.Signals,
  options: TerminateProcessOptions = {},
): void {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    if (child.pid !== undefined) {
      try {
        const spawnFn =
          options.spawnTaskkill ??
          ((command, args, spawnOptions) =>
            spawn(command, [...args], spawnOptions))
        const killer = spawnFn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
          stdio: 'ignore',
          windowsHide: true,
        })
        killer.unref()
        killer.once('error', () => {
          try {
            child.kill(signal)
          } catch {
            // Process already exited.
          }
        })
        return
      } catch {
        // Fall back to signaling the direct child if spawning taskkill fails synchronously.
      }
    }
    try {
      child.kill(signal)
    } catch {
      // Process already exited.
    }
    return
  }
  if (child.pid !== undefined) {
    try {
      const killFn = options.killGroup ?? process.kill
      killFn(-child.pid, signal)
      return
    } catch {
      // Fall back to signaling the direct child if process-group signaling fails.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Process already exited.
  }
}

export const spawnAcp: AcpSpawner = (argv, cwd) => {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    env: buildAgyEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_STDERR_TAIL_CHARS)
  })
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      child.once('error', (error) => {
        stderr += error.message
        resolve({ code: null, signal: error.message })
      })
      child.once('exit', (code, signal) => resolve({ code, signal }))
    },
  )
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    exited,
    stderrTail: () => redactStderr(stderr),
    terminate: () => {
      terminateProcessTree(child, 'SIGTERM')
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          terminateProcessTree(child, 'SIGKILL')
      }, 5000)
      timer.unref()
      void exited.then(() => clearTimeout(timer))
    },
  }
}

export const runCommand: CommandRunner = (
  argv: readonly string[],
  timeout: number,
  options?: CommandOptions,
): Promise<CommandOutput> =>
  new Promise((resolve) => {
    if (options?.signal?.aborted) {
      resolve({
        code: -1,
        stdout: '',
        stderr: 'command aborted',
        abortedBy: 'signal',
      })
      return
    }
    const maxStdoutBytes = options?.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES
    const child = spawn(argv[0]!, argv.slice(1), {
      env: buildAgyEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderr = ''
    let settled = false
    let abortedBy: CommandOutput['abortedBy']
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let exitDrainTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (code: number | null, errorMessage?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (settleTimer !== undefined) clearTimeout(settleTimer)
      if (exitDrainTimer !== undefined) clearTimeout(exitDrainTimer)
      options?.signal?.removeEventListener('abort', onSignalAbort)
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      let finalStderr = redactStderr(stderr || errorMessage || '')
      if (abortedBy === 'timeout' && finalStderr.trim().length === 0) {
        finalStderr = 'command timed out'
      } else if (abortedBy === 'maxStdout' && finalStderr.trim().length === 0) {
        finalStderr = `stdout exceeded ${maxStdoutBytes} bytes`
      } else if (abortedBy === 'signal' && finalStderr.trim().length === 0) {
        finalStderr = 'command aborted'
      }
      resolve({
        code:
          abortedBy !== undefined
            ? code !== null && code !== 0
              ? code
              : -1
            : (code ?? -1),
        stdout,
        stderr: finalStderr,
        ...(abortedBy !== undefined ? { abortedBy } : {}),
      })
    }

    const abort = (reason: NonNullable<CommandOutput['abortedBy']>): void => {
      if (settled || abortedBy !== undefined) return
      abortedBy = reason
      child.stdout.destroy()
      child.stderr.destroy()
      terminateProcessTree(child, 'SIGTERM')
      killTimer = setTimeout(() => {
        if (settled) return
        terminateProcessTree(child, 'SIGKILL')
        settleTimer = setTimeout(() => {
          finish(child.exitCode)
        }, SIGKILL_SETTLE_MS)
        settleTimer.unref()
      }, 1000)
      killTimer.unref()
    }

    const onSignalAbort = (): void => abort('signal')
    options?.signal?.addEventListener('abort', onSignalAbort, { once: true })

    const timeoutTimer = setTimeout(() => abort('timeout'), timeout)
    timeoutTimer.unref()

    child.stdout.on('data', (chunk: Buffer) => {
      if (abortedBy !== undefined) return
      stdoutBytes += chunk.length
      if (stdoutBytes > maxStdoutBytes) {
        abort('maxStdout')
        return
      }
      stdoutChunks.push(chunk)
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const combined = stderr + chunk
      stderr = combined.slice(-MAX_STDERR_TAIL_CHARS)
      if (abortedBy === undefined && options?.abortOnStderr?.test(combined)) {
        abort('stderr')
      }
    })

    child.once('error', (error) => {
      finish(-1, error.message)
    })

    child.once('exit', (code) => {
      if (settled || exitDrainTimer !== undefined) return
      // Prevent detached grandchildren inheriting stdio pipes from hanging runCommand indefinitely.
      exitDrainTimer = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        finish(code)
      }, EXIT_DRAIN_MS)
      exitDrainTimer.unref()
    })

    child.once('close', (code) => {
      finish(code)
    })
  })
