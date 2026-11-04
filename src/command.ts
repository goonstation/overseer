import { spawn } from 'node:child_process'
import { errorCode } from './errors.js'

export interface CommandOptions { cwd?: string; signal?: AbortSignal }
export interface CommandResult { stdout: string; stderr?: string }
export type CommandRunner = (file: string, args: readonly string[], options?: CommandOptions) => Promise<CommandResult>
interface CommandError extends Error {
  code?: string | number | null
  killed?: boolean
  signal?: NodeJS.Signals | null
}

// Linux process groups keep a timed-out ./dc wrapper's children from outliving its lock.
export function createCommandRunner(timeout: number): CommandRunner {
  return async (file, args, { cwd, signal } = {}) => {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      })
      const output: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] }
      let size = 0
      let failure: CommandError | undefined
      const terminate = (error: CommandError) => {
        if (failure) return
        failure = error
        error.killed = true
        error.signal = 'SIGKILL'
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL') }
          catch (killError) { if (errorCode(killError) !== 'ESRCH') child.kill('SIGKILL') }
        }
      }
      const timer = setTimeout(() => terminate(Object.assign(new Error('Command timed out'), {
        code: 'ETIMEDOUT',
      })), timeout)
      timer.unref()
      const onAbort = () => terminate(Object.assign(new Error('Command aborted', { cause: signal?.reason }), {
        name: 'AbortError', code: 'ABORT_ERR',
      }))
      signal?.addEventListener('abort', onAbort, { once: true })
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream].on('data', (chunk) => {
          size += chunk.length
          if (size > 1024 * 1024) {
            terminate(Object.assign(new Error('Command output limit exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }))
          } else { output[stream].push(chunk) }
        })
      }
      child.once('error', (error) => { failure ??= error })
      child.once('close', (code, exitSignal) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const result = {
          stdout: Buffer.concat(output.stdout).toString('utf8'),
          stderr: Buffer.concat(output.stderr).toString('utf8'),
        }
        if (failure || code !== 0) {
          const error = failure ?? Object.assign(new Error(`${file} exited unsuccessfully`), {
            code, signal: exitSignal,
          })
          reject(Object.assign(error, result))
        } else { resolve(result) }
      })
    })
  }
}
