import { spawn, type ChildProcess } from 'node:child_process'
import type { AcpSpawner } from './acp-process.ts'
import type { CommandOptions, CommandOutput, CommandRunner } from './preflight.ts'

const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_STDERR_TAIL_CHARS = 65_536

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
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
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
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
    stderrTail: () => stderr,
    terminate: () => {
      signalChild(child, 'SIGTERM')
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          signalChild(child, 'SIGKILL')
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
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderr = ''
    let settled = false
    let abortedBy: CommandOutput['abortedBy']
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (code: number | null, errorMessage?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      options?.signal?.removeEventListener('abort', onSignalAbort)
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      let finalStderr = stderr || errorMessage || ''
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
      signalChild(child, 'SIGTERM')
      killTimer = setTimeout(() => {
        if (!settled) signalChild(child, 'SIGKILL')
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

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_TAIL_CHARS)
      if (abortedBy === undefined && options?.abortOnStderr?.test(stderr)) {
        abort('stderr')
      }
    })

    child.once('error', (error) => {
      finish(-1, error.message)
    })

    child.once('close', (code) => {
      finish(code)
    })
  })
