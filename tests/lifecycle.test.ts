import test from 'node:test'
import assert from 'node:assert/strict'
import { createLifecycle } from '../src/lifecycle.js'

const token = 'updater-attempt-123'

test('drain rejects new work immediately while existing work completes', async () => {
  const lifecycle = createLifecycle()
  const upload = lifecycle.admit('uploads')
  const restart = lifecycle.admit('restarts')
  const status = lifecycle.drain(token)
  assert.equal(status.mode, 'draining')
  assert.deepEqual(status.active, { uploads: 1, restarts: 1 })
  assert.equal(status.ready, false)
  assert.throws(() => lifecycle.admit('uploads'), { statusCode: 503 })
  let idle = false
  const wait = lifecycle.waitForIdle().then(() => { idle = true })
  upload()
  await Promise.resolve()
  assert.equal(idle, false)
  restart()
  await wait
  assert.equal(lifecycle.status().ready, true)
  upload()
  assert.deepEqual(lifecycle.status().active, { uploads: 0, restarts: 0 })
  lifecycle.resume(token)
})

test('only the drain owner can renew, seal or resume a drain', () => {
  const lifecycle = createLifecycle()
  lifecycle.drain(token)
  for (const action of [() => lifecycle.drain('another-updater-owner-456'), () => lifecycle.seal('another-updater-owner-456'), () => lifecycle.resume('another-updater-owner-456')]) {
    assert.throws(action, { statusCode: 409 })
  }
  lifecycle.drain(token)
  lifecycle.seal(token)
  assert.equal(lifecycle.status().mode, 'sealed')
  lifecycle.resume(token)
  assert.equal(lifecycle.status().mode, 'running')
})

test('busy work cannot be sealed and a sealed handoff never expires automatically', async () => {
  const lifecycle = createLifecycle({ leaseMs: 20 })
  const finish = lifecycle.admit('uploads')
  lifecycle.drain(token)
  assert.throws(() => lifecycle.seal(token), { statusCode: 409 })
  finish()
  lifecycle.seal(token)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(lifecycle.status().mode, 'sealed')
  assert.throws(() => lifecycle.admit('restarts'), { statusCode: 503 })
  lifecycle.resume(token)
})

test('abandoned unsealed drain expires so callers can submit again', async () => {
  const lifecycle = createLifecycle({ leaseMs: 20 })
  lifecycle.drain(token)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(lifecycle.status().mode, 'running')
  lifecycle.admit('uploads')()
})

test('shutdown cannot be undone and waits for all admitted work', async () => {
  const lifecycle = createLifecycle()
  const finish = lifecycle.admit('restarts')
  lifecycle.stop()
  assert.equal(lifecycle.status().mode, 'stopping')
  assert.throws(() => lifecycle.resume(token), { statusCode: 409 })
  assert.throws(() => lifecycle.admit('uploads'), { statusCode: 503 })
  finish()
  await lifecycle.waitForIdle()
})

test('an abandoned maintenance client cannot renew or seal after the updater resumes service', () => {
  const lifecycle = createLifecycle()
  lifecycle.drain(token)
  lifecycle.resume(token)
  assert.throws(() => lifecycle.renew(token), { statusCode: 409 })
  assert.throws(() => lifecycle.seal(token), { statusCode: 409 })
})

test('a resumed attempt cannot reclaim a drain after its docker exec client is orphaned', () => {
  const lifecycle = createLifecycle()
  lifecycle.resume(token)
  assert.throws(() => lifecycle.drain(token), { statusCode: 409 })
})
