import { spawn, execFile } from 'node:child_process'
import type { AcpSpawner } from './acp-process.ts'
import type { CommandRunner } from './preflight.ts'

export const spawnAcp: AcpSpawner = (argv, cwd) => {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-65536)
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
      child.kill('SIGTERM')
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL')
      }, 5000)
      timer.unref()
      void exited.then(() => clearTimeout(timer))
    },
  }
}
export const runCommand: CommandRunner = (argv, timeout) =>
  new Promise((resolve) => {
    execFile(
      argv[0]!,
      argv.slice(1),
      { timeout, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
          stdout,
          stderr: stderr || error?.message || '',
        })
      },
    )
  })
