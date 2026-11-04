import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after } from 'node:test'
import type { CommandRunner } from '../src/command.js'
import type { ManagementConfig } from '../src/management.js'
import * as management from '../src/management.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'overseer-management-'))
after(() => rmSync(root, { recursive: true, force: true }))
const config = {
  containerPrefix: 'ss13-', serversRoot: root, commandTimeoutMs: 1000,
  restartTimeoutMs: 2000, operationLimit: 3, operationTtlMs: 60000,
}
const state = (status = 'running', health: string | null = 'healthy') => JSON.stringify([{
  State: { Status: status, StartedAt: '2026-11-03T10:00:00Z',
    ...(health ? { Health: { Status: health } } : {}) },
}])
const tick = () => new Promise((resolve) => setImmediate(resolve))

function service(run: CommandRunner, overrides: Partial<ManagementConfig> = {}) {
  assert.equal(typeof management.createManagementService, 'function', 'management must expose a testable service')
  return management.createManagementService({ ...config, ...overrides }, { run })
}

test('status includes stopped containers, missing health checks, and individual inspection failures', async () => {
  const svc = service(async (file, args) => {
    assert.equal(file, 'docker')
    if (args[0] === 'container') {
      assert.ok(args.includes('--all'), 'stopped servers must be listed')
      return { stdout: 'ss13-alpha\nss13-beta\nss13-broken\nother\n' }
    }
    if (args.at(-1) === 'ss13-broken') throw new Error('Docker internal detail')
    return { stdout: state(args.at(-1) === 'ss13-beta' ? 'exited' : 'running', null) }
  })
  const result = await svc.getAllServersStatus()
  assert.equal(result.alpha.health, null)
  assert.equal(result.beta.status, 'exited')
  assert.equal(result.broken.status, 'unknown')
  assert.equal(result.broken.error, 'Unable to inspect container')
  assert.equal(result.other, undefined)
})

test('restart reserves the server before asynchronous checks and exposes success', async () => {
  let unblock!: () => void
  const gate = new Promise<void>((resolve) => { unblock = resolve })
  let signals = 0
  const svc = service(async (file, args, options) => {
    if (args[0] === 'container') return { stdout: 'ss13-alpha\n' }
    if (args[0] === 'inspect') return { stdout: state() }
    if (args[0] === 'exec') { signals++; await gate }
    if (file === './dc') assert.equal(options?.cwd, path.join(root, 'alpha/game/tools/server'))
    return { stdout: '' }
  })
  const op = await svc.restartServer('alpha')
  assert.ok(op.id)
  assert.equal(svc.getOperation(op.id)!.state, 'running')
  await assert.rejects(svc.restartServer('alpha'), { statusCode: 409 })
  unblock()
  await tick()
  assert.equal(svc.getOperation(op.id)!.state, 'succeeded')
  assert.equal(signals, 1)
  assert.ok(svc.getOperation(op.id)!.finishedAt)
})

test('failed restart is observable and releases the lock for retry', async () => {
  const svc = service(async (file, args) => {
    if (args[0] === 'container') return { stdout: 'ss13-alpha' }
    if (args[0] === 'inspect') return { stdout: state('exited', null) }
    throw new Error('secret command stderr')
  })
  const op = await svc.restartServer('alpha')
  await tick()
  assert.equal(svc.getOperation(op.id)!.state, 'failed')
  assert.equal(svc.getOperation(op.id)!.error, 'Restart failed')
  assert.equal(svc.getOperation(op.id)!.step, 'compose down')
  assert.ok((await svc.restartServer('alpha')).id)
  await tick()
})

test('operation history is bounded without evicting active operations', async () => {
  const svc = service(async (file, args) => {
    if (args[0] === 'container') return { stdout: 'ss13-alpha' }
    if (args[0] === 'inspect') return { stdout: state() }
    return { stdout: '' }
  }, { operationLimit: 1 })
  const first = await svc.restartServer('alpha')
  await tick()
  const second = await svc.restartServer('alpha')
  await tick()
  assert.equal(svc.getOperation(first.id), null)
  assert.equal(svc.getOperation(second.id)!.state, 'succeeded')
})

test('invalid server names are rejected before invoking Docker', async () => {
  const svc = service(() => { assert.fail('must not invoke a command') })
  for (const name of ['../escape', "x';id", '-option', '', 'x/y']) {
    await assert.rejects(svc.restartServer(name), { statusCode: 400 })
  }
})

test('restart deadline records timeout and releases its server lock', async () => {
  const svc = service(async (file, args, options) => {
    if (args[0] === 'container') return { stdout: 'ss13-alpha' }
    if (args[0] === 'inspect') return { stdout: state() }
    const signal = options?.signal
    assert.ok(signal)
    await new Promise<never>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    assert.fail('aborted restart cannot continue')
  }, { restartTimeoutMs: 20 })
  const op = await svc.restartServer('alpha')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(svc.getOperation(op.id)!.state, 'failed')
  assert.equal(svc.getOperation(op.id)!.error, 'Restart timed out')
  const retry = await svc.restartServer('alpha')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(svc.getOperation(retry.id)!.state, 'failed')
})

test('upload and restart services share the same target lock', async () => {
  const { createLocks } = await import('../src/locks.js')
  const locks = createLocks()
  const release = locks.acquire(['server:alpha'])
  const svc = management.createManagementService(config, {
    locks, run() { assert.fail('locked target must not reach Docker') },
  })
  await assert.rejects(svc.restartServer('alpha'), { statusCode: 409 })
  release()
})

test('simultaneous different-server restarts cannot exceed active operation capacity', async () => {
  let unblock!: () => void
  const gate = new Promise<void>((resolve) => { unblock = resolve })
  const svc = service(async (file, args) => {
    if (args[0] === 'container') return { stdout: 'ss13-alpha\nss13-beta' }
    if (args[0] === 'inspect') return { stdout: state() }
    await gate
    return { stdout: '' }
  }, { operationLimit: 1 })
  try {
    const results = await Promise.allSettled([svc.restartServer('alpha'), svc.restartServer('beta')])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.ok(rejected)
    assert.equal(rejected.reason.statusCode, 503)
  } finally { unblock(); await tick() }
})

test('drain tracks detached restart work until all commands finish', async () => {
  const { createLifecycle } = await import('../src/lifecycle.js')
  const lifecycle = createLifecycle()
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const svc = management.createManagementService(config, { lifecycle, async run(file, args) {
    if (args[0] === 'container') return { stdout: 'ss13-alpha' }
    if (args[0] === 'inspect') return { stdout: state() }
    await gate
    return { stdout: '' }
  } })
  const op = await svc.restartServer('alpha')
  const drain = lifecycle.drain('restart-update-attempt-123')
  assert.equal(drain.active.restarts, 1)
  await assert.rejects(svc.restartServer('alpha'), { statusCode: 503 })
  assert.throws(() => lifecycle.seal('restart-update-attempt-123'), { statusCode: 409 })
  finish()
  await lifecycle.waitForIdle()
  assert.equal(svc.getOperation(op.id)?.state, 'succeeded')
  assert.equal(lifecycle.status().ready, true)
  lifecycle.resume('restart-update-attempt-123')
})
