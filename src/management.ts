import { createLifecycle } from './lifecycle.js'
import { randomUUID } from 'node:crypto'
import { HttpError } from './errors.js'
import { identifier, managedPath } from './validation.js'
import { createLocks } from './locks.js'
import { createCommandRunner } from './command.js'
import type { Config } from './config.js'
import type { ServiceDependencies } from './services.js'

export type ManagementConfig = Pick<Config, 'containerPrefix' | 'serversRoot' | 'commandTimeoutMs' | 'restartTimeoutMs' | 'operationLimit' | 'operationTtlMs'>
export interface ServerStatus {
  restarting: boolean
  status: string
  health: string | null
  startedAt: string | null
  error?: string
}
export type RestartStep = 'stop game' | 'compose down' | 'compose up'
interface OperationBase { id: string; server: string; startedAt: string }
export type RestartOperation = OperationBase & (
  | { state: 'running'; step: RestartStep; finishedAt: null; error: null }
  | { state: 'succeeded'; step: 'complete'; finishedAt: string; error: null }
  | { state: 'failed'; step: RestartStep; finishedAt: string; error: string }
)
export interface ManagementService {
  getServerStatus(server: string): Promise<ServerStatus>
  getAllServersStatus(): Promise<Record<string, ServerStatus>>
  restartServer(server: string): Promise<RestartOperation>
  getOperation(id: string): RestartOperation | null
}

function dockerState(value: unknown): { Status: string; StartedAt: string; Health?: { Status: string } } {
  if (!Array.isArray(value) || !value.length) throw new Error('Invalid Docker inspect response')
  const container: unknown = value[0]
  if (typeof container !== 'object' || container === null || !('State' in container)) throw new Error('Invalid Docker state')
  const state = container.State
  if (typeof state !== 'object' || state === null || !('Status' in state) || typeof state.Status !== 'string' ||
      !('StartedAt' in state) || typeof state.StartedAt !== 'string') throw new Error('Invalid Docker state')
  const result: { Status: string; StartedAt: string; Health?: { Status: string } } = { Status: state.Status, StartedAt: state.StartedAt }
  if ('Health' in state && state.Health !== undefined && state.Health !== null) {
    if (typeof state.Health !== 'object' || !('Status' in state.Health) || typeof state.Health.Status !== 'string') throw new Error('Invalid Docker health')
    result.Health = { Status: state.Health.Status }
  }
  return result
}

export function createManagementService(config: ManagementConfig, {
  run = createCommandRunner(config.commandTimeoutMs),
  locks = createLocks(), onError = () => {}, lifecycle = createLifecycle(),
}: ServiceDependencies = {}): ManagementService {
  const operations = new Map<string, RestartOperation>()
  const active = new Set<string>()

  async function getServers() {
    const { stdout } = await run('docker', ['container', 'ls', '--all', '--format', '{{.Names}}'])
    return stdout.trim().split('\n')
      .filter((name) => name.startsWith(config.containerPrefix))
      .map((name) => name.slice(config.containerPrefix.length))
      .filter((name) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name))
  }

  async function inspect(server: string): Promise<ServerStatus> {
    const { stdout } = await run('docker', ['inspect', `${config.containerPrefix}${server}`])
    const state = dockerState(JSON.parse(stdout))
    return {
      restarting: active.has(server), status: state.Status,
      health: state.Health?.Status ?? null, startedAt: state.StartedAt,
    }
  }

  async function getServerStatus(server: string) {
    identifier(server)
    if (!(await getServers()).includes(server)) throw new HttpError(404, 'Server not found')
    return inspect(server)
  }

  async function getAllServersStatus() {
    const servers = await getServers()
    const result: Record<string, ServerStatus> = Object.create(null)
    // Bound process concurrency rather than starting a Docker CLI per server at once.
    for (let i = 0; i < servers.length; i += 4) {
      await Promise.all(servers.slice(i, i + 4).map(async (server) => {
        try { result[server] = await inspect(server) }
        catch (error) {
          onError(error, { action: 'inspect', server })
          result[server] = {
            restarting: active.has(server), status: 'unknown', health: null,
            startedAt: null, error: 'Unable to inspect container',
          }
        }
      }))
    }
    return result
  }

  function prune(makeRoom = false) {
    const cutoff = Date.now() - config.operationTtlMs
    for (const [id, operation] of operations) {
      if (operation.finishedAt && Date.parse(operation.finishedAt) <= cutoff) operations.delete(id)
    }
    if (makeRoom) {
      for (const [id, operation] of operations) {
        if (operations.size < config.operationLimit) break
        if (operation.finishedAt) operations.delete(id)
      }
    }
  }

  function getOperation(id: string) {
    prune()
    const operation = operations.get(id)
    return operation ? { ...operation } : null
  }

  async function restartServer(server: string) {
    identifier(server)
    const finish = lifecycle.admit('restarts')
    let unlock = () => {}
    const release = () => { unlock(); finish() }
    try {
      unlock = locks.acquire([`server:${server}`])
      if (!(await getServers()).includes(server)) throw new HttpError(404, 'Server not found')
      const status = await inspect(server)
      if (status.health === 'starting') throw new HttpError(409, 'Server is starting')
      // Resolve before invoking ./dc so a symlink selected by a server name cannot escape the root.
      const projectDir = await managedPath(config.serversRoot, server, 'game', 'tools', 'server')
      // No await between capacity check and insertion: concurrent servers share this budget.
      prune(true)
      if (operations.size >= config.operationLimit) throw new HttpError(503, 'Operation capacity reached')
      const operation: RestartOperation = {
        id: randomUUID(), server, state: 'running', step: 'stop game',
        startedAt: new Date().toISOString(), finishedAt: null, error: null,
      }
      operations.set(operation.id, operation)
      active.add(server)
      const work = async () => {
        const signal = AbortSignal.timeout(config.restartTimeoutMs)
        const options = { signal }
        let step: RestartStep = 'stop game'
        try {
          // A stopped game has no DreamDaemon to signal, but should still be restartable.
          if (status.status === 'running') {
            await run('docker', ['exec', `${config.containerPrefix}${server}`, 'pkill', '-USR2', 'DreamDaemon'], options)
          }
          step = 'compose down'
          operations.set(operation.id, { ...operation, step })
          await run('./dc', ['down'], { ...options, cwd: projectDir })
          step = 'compose up'
          operations.set(operation.id, { ...operation, step })
          await run('./dc', ['up', '-d'], { ...options, cwd: projectDir })
          operations.set(operation.id, { ...operation, state: 'succeeded', step: 'complete', finishedAt: new Date().toISOString(), error: null })
        } catch (error) {
          operations.set(operation.id, { ...operation, state: 'failed', step, finishedAt: new Date().toISOString(), error: signal.aborted ? 'Restart timed out' : 'Restart failed' })
          onError(error, { action: 'restart', server, operationId: operation.id, step })
        } finally {
          active.delete(server)
          release()
        }
      }
      // Handlers inside work consume all command failures; requests can poll independently.
      void work()
      return { ...operations.get(operation.id)! }
    } catch (error) {
      release()
      throw error
    }
  }

  return { getServerStatus, getAllServersStatus, restartServer, getOperation }
}
