import { randomUUID } from 'node:crypto'
import { HttpError } from './errors.js'

export type Activity = 'uploads' | 'restarts'
export type LifecycleMode = 'running' | 'draining' | 'sealed' | 'stopping'
export interface LifecycleStatus {
  instanceId: string
  mode: LifecycleMode
  active: Record<Activity, number>
  ready: boolean
  drainId: string | null
  leaseExpiresAt: string | null
}

export function createLifecycle({ leaseMs = 120000 }: { leaseMs?: number } = {}) {
  const instanceId = randomUUID()
  const active = { uploads: 0, restarts: 0 }
  const idleWaiters = new Set<() => void>()
  const revoked = new Map<string, number>()
  let mode: LifecycleMode = 'running'
  let owner: string | null = null
  let expiresAt: number | null = null
  let timer: NodeJS.Timeout | undefined
  const idle = () => active.uploads === 0 && active.restarts === 0
  const clearLease = () => { clearTimeout(timer); timer = undefined; expiresAt = null }
  const expire = () => {
    if (mode === 'draining' && expiresAt !== null && Date.now() >= expiresAt) {
      clearLease()
      owner = null
      mode = 'running'
    }
  }
  const token = (value: string) => {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new HttpError(400, 'Invalid drain token')
  }
  const owned = (value: string) => {
    token(value)
    expire()
    if (owner !== value || (mode !== 'draining' && mode !== 'sealed')) {
      throw new HttpError(409, 'Drain is not owned by this updater')
    }
  }
  const renewLease = () => {
    clearLease()
    expiresAt = Date.now() + leaseMs
    timer = setTimeout(expire, leaseMs)
    timer.unref()
  }
  const status = (): LifecycleStatus => {
    expire()
    return {
      instanceId, mode, active: { ...active }, ready: mode !== 'running' && idle(),
      drainId: owner, leaseExpiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    }
  }
  return {
    status,
    admit(kind: Activity): () => void {
      expire()
      if (mode !== 'running') throw new HttpError(503, 'Overseer is draining; retry later')
      active[kind]++
      let released = false
      return () => {
        if (released) return
        released = true
        active[kind]--
        if (idle()) {
          for (const resolve of idleWaiters) resolve()
          idleWaiters.clear()
        }
      }
    },
    drain(value: string): LifecycleStatus {
      token(value)
      expire()
      for (const [id, expiry] of revoked) if (expiry <= Date.now()) revoked.delete(id)
      if (revoked.has(value)) throw new HttpError(409, 'Update attempt has been revoked')
      if (mode === 'stopping') throw new HttpError(409, 'Overseer is stopping')
      if (mode !== 'running') owned(value)
      owner = value
      if (mode !== 'sealed') {
        mode = 'draining'
        renewLease()
      }
      return status()
    },
    renew(value: string): LifecycleStatus {
      owned(value)
      if (mode === 'draining') renewLease()
      return status()
    },
    seal(value: string): LifecycleStatus {
      owned(value)
      if (!idle()) throw new HttpError(409, 'Work is still active')
      clearLease()
      mode = 'sealed'
      return status()
    },
    resume(value: string): LifecycleStatus {
      token(value)
      expire()
      if (mode !== 'running') owned(value)
      revoked.set(value, Date.now() + 24 * 60 * 60 * 1000)
      while (revoked.size > 4096) revoked.delete(revoked.keys().next().value!)
      if (mode === 'running') return status()
      clearLease()
      owner = null
      mode = 'running'
      return status()
    },
    stop(): void {
      clearLease()
      mode = 'stopping'
    },
    waitForIdle(): Promise<void> {
      if (idle()) return Promise.resolve()
      return new Promise((resolve) => idleWaiters.add(resolve))
    },
  }
}
export type Lifecycle = ReturnType<typeof createLifecycle>
