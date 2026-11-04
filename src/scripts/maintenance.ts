import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { LifecycleStatus } from '../lifecycle.js'
import { toError } from '../errors.js'

export interface MaintenanceOptions {
  url: string
  apiToken: string
  token?: string
  timeoutMs?: number
  pollMs?: number
}
export type MaintenanceAction = 'wait' | 'resume' | 'ready' | 'await-ready' | 'sealed'

function responseStatus(value: unknown): LifecycleStatus {
  if (typeof value !== 'object' || value === null || !('instanceId' in value) || typeof value.instanceId !== 'string' ||
      !('mode' in value) || !['running', 'draining', 'sealed', 'stopping'].includes(String(value.mode)) ||
      !('ready' in value) || typeof value.ready !== 'boolean' ||
      !('drainId' in value) || !(value.drainId === null || typeof value.drainId === 'string') ||
      !('active' in value) || typeof value.active !== 'object' || value.active === null ||
      !('uploads' in value.active) || !Number.isSafeInteger(value.active.uploads) || Number(value.active.uploads) < 0 ||
      !('restarts' in value.active) || !Number.isSafeInteger(value.active.restarts) || Number(value.active.restarts) < 0 ||
      !('leaseExpiresAt' in value) || !(value.leaseExpiresAt === null || typeof value.leaseExpiresAt === 'string')) {
    throw new Error('Unsupported maintenance response; deploy a drain-aware version first')
  }
  // All public fields have been checked at this external JSON boundary.
  return value as LifecycleStatus
}

export async function runMaintenance(action: MaintenanceAction, {
  url, apiToken, token, timeoutMs = 600000, pollMs = 1000,
}: MaintenanceOptions): Promise<LifecycleStatus> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error('Invalid maintenance timeout')
  const deadline = Date.now() + timeoutMs
  const request = async (route: string, method = 'GET') => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Maintenance deadline exceeded; existing work was not stopped')
    const response = await fetch(new URL(route, url), {
      method,
      headers: { Authorization: `Bearer ${apiToken}`, ...(token ? { 'X-Drain-Token': token } : {}) },
      signal: AbortSignal.timeout(Math.min(5000, remaining)),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Maintenance request ${route} failed with HTTP ${response.status}`)
    }
    return responseStatus(await response.json())
  }
  if (action === 'sealed') {
    const status = await request('/maintenance')
    if (action === 'sealed' && (status.mode !== 'sealed' || status.drainId !== token || !status.ready || status.active.uploads !== 0 || status.active.restarts !== 0)) throw new Error('Instance is not sealed by this updater')
    return status
  }
  if (action === 'resume') {
    const status = await request('/maintenance/resume', 'POST')
    if (status.mode !== 'running') throw new Error('Instance did not resume')
    return status
  }
  if (action === 'ready' || action === 'await-ready') {
    while (true) {
      try {
        const status = await request('/maintenance')
        if (status.mode !== 'running') throw new Error('Instance is not accepting work')
        return status
      } catch (error) {
        if (action === 'ready' || Date.now() >= deadline) throw error
        await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
      }
    }
  }
  if (!token) throw new Error('A drain token is required')
  let status = await request('/maintenance/drain', 'POST')
  const instanceId = status.instanceId
  while (true) {
    if (status.instanceId !== instanceId || status.drainId !== token || !['draining', 'sealed'].includes(status.mode)) {
      throw new Error('Drain ownership or instance changed; refusing replacement')
    }
    if (status.ready && status.active.uploads === 0 && status.active.restarts === 0) {
      const sealed = await request('/maintenance/seal', 'POST')
      if (sealed.instanceId !== instanceId || sealed.mode !== 'sealed' || sealed.drainId !== token ||
          !sealed.ready || sealed.active.uploads !== 0 || sealed.active.restarts !== 0) {
        throw new Error('Invalid sealed handoff; refusing replacement')
      }
      return sealed
    }
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    // Renewal cannot reclaim a drain after a failed updater has resumed service.
    status = await request('/maintenance/renew', 'POST')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const action = process.argv[2]
    if (!['wait', 'resume', 'ready', 'await-ready', 'sealed'].includes(action)) throw new Error('Expected wait, resume, ready or await-ready')
    if (!process.env.API_TOKEN) throw new Error('API_TOKEN is required')
    const status = await runMaintenance(action as MaintenanceAction, {
      url: `http://127.0.0.1:${process.env.SERVER_PORT ?? '8564'}`,
      apiToken: process.env.API_TOKEN,
      token: process.env.OVERSEER_UPDATE_DRAIN_TOKEN,
      timeoutMs: Number(process.env.OVERSEER_UPDATE_CLIENT_TIMEOUT_MS ?? (action === 'await-ready' ? 60000 : 600000)),
    })
    console.log(status.instanceId)
  } catch (error) {
    console.error(toError(error).message)
    process.exitCode = 1
  }
}
