import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import type { AppConfig, AppServices } from '../src/app.js'
import type { DeploymentService, UploadSession } from '../src/deployments.js'
import type { FallbackService } from '../src/fallbacks.js'
import type { ManagementService } from '../src/management.js'
import { createLifecycle } from '../src/lifecycle.js'
import { serverPort } from './helpers/server.js'

interface FixtureOptions {
  session?: Partial<UploadSession>
  management?: Partial<ManagementService>
  deployments?: Partial<DeploymentService>
  fallbacks?: Partial<FallbackService>
  config?: Partial<AppConfig>
}
interface MultipartPart { name: string; type: string; body: string }
const operationBase = { id: 'operation-123', server: 'alpha', startedAt: '2026-11-03T12:00:00Z' }
const statusBase = { restarting: false, startedAt: '2026-11-03T12:00:00Z', health: null }

const token = 'a-test-token-with-at-least-32-characters'
const defaults = {
  apiToken: token, maxUploadBytes: 1024, maxRequestBytes: 8192,
  uploadTimeoutMs: 1000, requestTimeoutMs: 2000,
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const { createApp } = await import('../src/app.js')
  const lifecycle = createLifecycle()
  const session: UploadSession = {
    async add(name, file) { for await (const chunk of file) void chunk },
    async commit() {}, async abort() {},
    ...options.session,
  }
  const services: AppServices = {
    lifecycle,
    fallbacks: { async upload(server, file) { for await (const chunk of file) void chunk; return { server: 'main1' } }, ...options.fallbacks },
    management: {
      async getAllServersStatus() { return { alpha: { ...statusBase, status: 'exited' } } },
      async getServerStatus() { return { ...statusBase, status: 'running' } },
      async restartServer() { return { ...operationBase, state: 'running', step: 'stop game', finishedAt: null, error: null } },
      getOperation(id) { return id === 'operation-123' ? { ...operationBase, id, state: 'succeeded', step: 'complete', finishedAt: '2026-11-03T12:01:00Z', error: null } : null },
      ...options.management,
    },
    deployments: {
      async doesServerExist() { return true },
      async wantsNewArtifacts() { return { game: true, byond: false, rustg: false } },
      async beginUpload() { return session },
      ...options.deployments,
    },
  }
  const server = createApp({ ...defaults, ...options.config }, services)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  const url = `http://127.0.0.1:${serverPort(server)}`
  return {
    server, url, lifecycle,
    request(route: string, options: RequestInit = {}) {
      return fetch(url + route, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } })
    },
  }
}
function multipart(parts: MultipartPart[] = [{ name: 'build', type: 'application/zip', body: 'fake-archive' }]) {
  const boundary = 'overseer-test-boundary'
  const body = parts.map(({ name, type, body }) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="file.zip"\r\nContent-Type: ${type}\r\n\r\n${body}\r\n`).join('') + `--${boundary}--\r\n`
  return { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body }
}

test('all routes require bearer authentication and errors are JSON', async (t) => {
  const { url, request } = await fixture(t)
  for (const route of ['/status', '/fallback/upload', '/restart?server=alpha', '/build/upload?server=alpha', '/operations/operation-123']) {
    const response = await fetch(url + route)
    assert.equal(response.status, 401)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  }
  assert.equal((await request('/status')).status, 200)
  assert.equal((await request('/status', { headers: { Authorization: 'Bearer wrong' } })).status, 401)
})

test('restart requires POST and returns a pollable operation', async (t) => {
  const { request } = await fixture(t)
  const rejected = await request('/restart?server=alpha')
  assert.equal(rejected.status, 405)
  assert.equal(rejected.headers.get('allow'), 'POST')
  const response = await request('/restart?server=alpha', { method: 'POST' })
  assert.equal(response.status, 202)
  assert.equal(response.headers.get('location'), '/operations/operation-123')
  const operation = await request(response.headers.get('location')!)
  assert.equal((await operation.json()).state, 'succeeded')
  assert.equal((await request('/operations/missing')).status, 404)
})

test('invalid query values are rejected before calling deployment or management', async (t) => {
  const { request } = await fixture(t, {
    management: { async restartServer() { assert.fail('invalid server reached service') } },
    deployments: { async wantsNewArtifacts() { assert.fail('invalid metadata reached service') } },
  })
  for (const route of [
    '/restart?server=..%2Fescape', '/restart?server=alpha&server=beta',
    '/restart',
  ]) assert.equal((await request(route, { method: 'POST' })).status, 400)
  for (const stamp of ['123junk', '-1', 'NaN', '9007199254740992']) {
    const response = await request(`/build/check?server=alpha&buildstamp=${stamp}&byond=valid&rustg=valid`)
    assert.equal(response.status, 400)
  }
  assert.equal((await request('/build/check?server=alpha&buildstamp=10&byond=..%2Fx&rustg=valid')).status, 400)
})

test('upload response waits for extraction and commit', async (t) => {
  let finish!: () => void
  let extractionStarted!: () => void
  const started = new Promise<void>((resolve) => { extractionStarted = resolve })
  const extraction = new Promise<void>((resolve) => { finish = resolve })
  let committed = false
  const { request } = await fixture(t, { session: {
    async add(name, file) {
      for await (const chunk of file) void chunk
      extractionStarted()
      await extraction
    },
    async commit() { committed = true },
  } })
  let responded = false
  const pending = request('/build/upload?server=alpha', multipart()).then((response) => {
    responded = true
    return response
  })
  await started
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(responded, false)
  finish()
  assert.equal((await pending).status, 200)
  assert.equal(committed, true)
})

test('asynchronous extraction failure returns an error and aborts the session', async (t) => {
  let aborted = false
  const { request } = await fixture(t, { session: {
    async add(name, file) {
      for await (const chunk of file) void chunk
      throw new Error('sensitive subprocess detail')
    },
    async commit() { assert.fail('must not commit a failed upload') },
    async abort() { aborted = true },
  } })
  const response = await request('/build/upload?server=alpha', multipart())
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { message: 'Internal server error' })
  assert.equal(aborted, true)
})

test('malformed multipart and unsupported, unknown, duplicate or oversized files cannot succeed', async (t) => {
  let commits = 0
  const { request } = await fixture(t, { session: { async commit() { commits++ } } })
  assert.equal((await request('/build/upload?server=alpha', {
    method: 'POST', headers: { 'Content-Type': 'multipart/form-data' }, body: 'bad',
  })).status, 400)
  const cases: [number, MultipartPart[]][] = [
    [415, [{ name: 'build', type: 'text/plain', body: 'bad' }]],
    [400, [{ name: 'unknown', type: 'application/zip', body: 'bad' }]],
    [400, Array(2).fill({ name: 'build', type: 'application/zip', body: 'bad' })],
    [413, [{ name: 'build', type: 'application/zip', body: 'a'.repeat(1025) }]],
  ]
  for (const [status, parts] of cases) {
    assert.equal((await request('/build/upload?server=alpha', multipart(parts))).status, status)
  }
  const broken = multipart()
  broken.body = broken.body.slice(0, -40)
  assert.equal((await request('/build/upload?server=alpha', broken)).status, 400)
  assert.equal(commits, 0)
})

test('unexpected service failures are contained and do not leak internals', async (t) => {
  const { request } = await fixture(t, { deployments: {
    async doesServerExist() { throw new Error('/private/path') },
  } })
  const response = await request('/build/check?server=alpha&buildstamp=10&byond=v1&rustg=v1')
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { message: 'Internal server error' })
  assert.equal((await request('/status')).status, 200)
})

test('disconnect during upload aborts the session', async (t) => {
  let notify!: () => void
  const aborted = new Promise<void>((resolve) => { notify = resolve })
  const { server } = await fixture(t, { session: { async abort() { notify() } } })
  const req = http.request({
    hostname: '127.0.0.1', port: serverPort(server),
    path: '/build/upload?server=alpha', method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data; boundary=unfinished' },
  })
  req.on('error', () => {})
  req.write('--unfinished\r\nContent-Disposition: form-data; name="build"; filename="x.zip"\r\nContent-Type: application/zip\r\n\r\nsome data')
  await new Promise((resolve) => setTimeout(resolve, 20))
  req.destroy()
  await Promise.race([aborted, new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('session was not aborted')), 2000)
    timeout.unref()
  })])
})

test('upload deadline aborts extraction before reporting a timeout', async (t) => {
  let cancelled = false
  const { request } = await fixture(t, {
    config: { uploadTimeoutMs: 30 },
    deployments: { async beginUpload(server, { signal } = {}) {
      assert.ok(signal)
      return {
        async add(name, file) {
          for await (const chunk of file) void chunk
          await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
            cancelled = true
            reject(signal.reason)
          }, { once: true }))
        },
        async commit() { assert.fail('timed out upload cannot commit') }, async abort() {},
      }
    } },
  })
  assert.equal((await request('/build/upload?server=alpha', multipart())).status, 408)
  assert.equal(cancelled, true)
})

test('exact upload size limit succeeds while a fourth part is rejected', async (t) => {
  let commits = 0
  const { request } = await fixture(t, { session: { async commit() { commits++ } } })
  assert.equal((await request('/build/upload?server=alpha', multipart([
    { name: 'build', type: 'application/zip', body: 'a'.repeat(1024) },
  ]))).status, 200)
  const parts = ['build', 'byond', 'rustg', 'unknown'].map((name) => ({
    name, type: 'application/zip', body: 'small',
  }))
  assert.equal((await request('/build/upload?server=alpha', multipart(parts))).status, 400)
  assert.equal(commits, 1)
})

test('disconnect after receiving the body cancels pending extraction', async (t) => {
  let began!: () => void
  let cancelled!: () => void
  const started = new Promise<void>((resolve) => { began = resolve })
  const aborted = new Promise<void>((resolve) => { cancelled = resolve })
  const { server } = await fixture(t, { deployments: {
    async beginUpload(server, { signal } = {}) {
      assert.ok(signal)
      return {
        async add(name, file) {
          for await (const chunk of file) void chunk
          began()
          await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
            reject(signal.reason)
          }, { once: true }))
        }, async commit() { assert.fail('disconnected upload cannot commit') },
        async abort() { cancelled() },
      }
    },
  } })
  const body = multipart()
  const req = http.request({
    hostname: '127.0.0.1', port: serverPort(server),
    path: '/build/upload?server=alpha', method: 'POST',
    headers: { ...body.headers, Authorization: `Bearer ${token}`, 'Content-Length': Buffer.byteLength(body.body) },
  })
  req.on('error', () => {})
  req.end(body.body)
  await started
  req.destroy()
  await Promise.race([aborted, new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('body-complete disconnect did not cancel work')), 200)
    timer.unref()
  })])
})

test('total chunked request size is enforced independently of each file limit', async (t) => {
  const { server } = await fixture(t, { config: { maxRequestBytes: 256 } })
  const options = multipart([{ name: 'build', type: 'application/zip', body: 'a'.repeat(500) }])
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: serverPort(server), method: 'POST', path: '/build/upload?server=alpha',
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.write(options.body)
    req.end()
  })
  assert.equal(status, 413)
})

test('drain counts admitted uploads, rejects new mutations and seals only after completion', async (t) => {
  let started!: () => void
  let finish!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const { request } = await fixture(t, { session: {
    async add(name, file) { for await (const chunk of file) void chunk; started(); await gate },
  } })
  t.after(() => finish())
  const upload = request('/build/upload?server=alpha', multipart())
  await entered
  const headers = { 'X-Drain-Token': 'http-updater-attempt-123' }
  const drain = await request('/maintenance/drain', { method: 'POST', headers })
  assert.equal(drain.status, 200)
  assert.deepEqual((await drain.json()).active, { uploads: 1, restarts: 0 })
  const denied = await request('/build/upload?server=alpha', multipart())
  assert.equal(denied.status, 503)
  assert.equal(denied.headers.get('retry-after'), '5')
  assert.equal((await request('/restart?server=alpha', { method: 'POST' })).status, 503)
  assert.equal((await request('/maintenance/seal', { method: 'POST', headers })).status, 409)
  assert.equal((await request('/status')).status, 200)
  finish()
  assert.equal((await upload).status, 200)
  const sealed = await request('/maintenance/seal', { method: 'POST', headers })
  assert.equal(sealed.status, 200)
  assert.equal((await sealed.json()).mode, 'sealed')
  assert.equal((await request('/maintenance/resume', { method: 'POST', headers: { 'X-Drain-Token': 'some-other-owner-123' } })).status, 409)
  assert.equal((await request('/maintenance/resume', { method: 'POST', headers })).status, 200)
  assert.equal((await request('/build/upload?server=alpha', multipart())).status, 200)
})

test('upload admission is counted before asynchronous path checks and released after failure', async (t) => {
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  const { request } = await fixture(t, { deployments: {
    async doesServerExist() { started(); await gate; throw new Error('path check failed') },
  } })
  const upload = request('/build/upload?server=alpha', multipart())
  await entered
  const headers = { 'X-Drain-Token': 'http-updater-attempt-456' }
  const drain = await request('/maintenance/drain', { method: 'POST', headers })
  assert.equal(drain.status, 200)
  assert.equal((await drain.json()).active.uploads, 1)
  release()
  assert.equal((await upload).status, 500)
  const status = await request('/maintenance')
  assert.equal((await status.json()).ready, true)
})

const rawFallback = (body = 'archive') => ({ method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body })

test('fallback route accepts a raw SQLite body and waits for publication while tracked by draining', async (t) => {
  let entered!: () => void
  let finish!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { finish = resolve })
  t.after(() => finish())
  const { request, lifecycle } = await fixture(t, { fallbacks: { async upload(server, file) {
    assert.equal(server, 'main1')
    let body = ''
    for await (const chunk of file) body += chunk
    assert.equal(body, 'archive')
    entered()
    await gate
    return { server: 'main1' }
  } } })
  assert.equal((await request('/fallback/upload?server=main1')).status, 405)
  assert.equal((await request('/fallback/upload?server=main1', { method: 'POST', body: 'bad' })).status, 415)
  const pending = request('/fallback/upload?server=main1', rawFallback())
  await started
  assert.equal(lifecycle.status().active.uploads, 1)
  lifecycle.drain('fallback-drain-attempt-123')
  assert.equal((await request('/fallback/upload?server=main1', rawFallback())).status, 503)
  finish()
  const response = await pending
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { message: 'Success', server: 'main1' })
  assert.equal(lifecycle.status().active.uploads, 0)
})

test('raw fallback limits cover content-length and chunked bodies without dropping the error response', async (t) => {
  const { request, server } = await fixture(t, { config: { maxRequestBytes: 16, maxUploadBytes: 32 } })
  assert.equal((await request('/fallback/upload?server=main1', rawFallback('x'.repeat(17)))).status, 413)
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: serverPort(server), path: '/fallback/upload?server=main1', method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.write('x'.repeat(17))
    req.end()
  })
  assert.equal(status, 413)
})

test('fallback deadline aborts work and releases drain tracking before reporting failure', async (t) => {
  let cancelled = false
  const { request, lifecycle } = await fixture(t, { config: { uploadTimeoutMs: 30 }, fallbacks: {
    async upload(server, file, { signal } = {}) {
      assert.ok(signal)
      for await (const chunk of file) void chunk
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        cancelled = true
        reject(signal.reason)
      }, { once: true }))
      return { server: 'main1' }
    },
  } })
  assert.equal((await request('/fallback/upload?server=main1', rawFallback())).status, 408)
  assert.equal(cancelled, true)
  assert.equal(lifecycle.status().active.uploads, 0)
})

test('fallback client disconnect cancels work after the complete request body', { timeout: 2000 }, async (t) => {
  let entered!: () => void
  let cancelled!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const aborted = new Promise<void>((resolve) => { cancelled = resolve })
  const { server, lifecycle } = await fixture(t, { fallbacks: { async upload(server, file, { signal } = {}) {
    assert.ok(signal)
    try {
      for await (const chunk of file) void chunk
      entered()
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      return { server: 'main1' }
    } finally { cancelled() }
  } } })
  const req = http.request({ hostname: '127.0.0.1', port: serverPort(server), path: '/fallback/upload?server=main1', method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': 7 },
  })
  req.on('error', () => {})
  req.end('archive')
  await started
  req.destroy()
  await aborted
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(lifecycle.status().active.uploads, 0)
})

test('fallback success remains successful when its cleanup completes after the upload deadline', async (t) => {
  const { request } = await fixture(t, { config: { uploadTimeoutMs: 30 }, fallbacks: {
    async upload(server, file, { signal } = {}) {
      assert.ok(signal)
      for await (const chunk of file) void chunk
      // Simulate an already committed service completing cleanup after cancellation.
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { server: 'main1' }
    },
  } })
  const response = await request('/fallback/upload?server=main1', rawFallback())
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { message: 'Success', server: 'main1' })
})

test('fallback upload requires exactly one valid server parameter', async (t) => {
  const { request } = await fixture(t, { fallbacks: { async upload() { assert.fail('invalid server reached upload') } } })
  for (const query of ['', '?server=', '?server=main1&server=main2', '?server=..%2Fescape']) {
    assert.equal((await request('/fallback/upload' + query, rawFallback())).status, 400)
  }
})

test('fallback accepts raw file media types and rejects the previous archive format', async (t) => {
  const { request } = await fixture(t)
  for (const type of ['application/octet-stream', 'application/vnd.sqlite3', 'application/x-sqlite3']) {
    assert.equal((await request('/fallback/upload?server=main1', { method: 'POST', headers: { 'Content-Type': type }, body: 'sqlite bytes' })).status, 200)
  }
  for (const type of ['application/gzip', 'application/zip', 'multipart/form-data; boundary=test']) {
    assert.equal((await request('/fallback/upload?server=main1', { method: 'POST', headers: { 'Content-Type': type }, body: 'archive' })).status, 415)
  }
})
