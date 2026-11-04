import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { createLifecycle } from '../src/lifecycle.js'
import { createApp } from '../src/app.js'
import { runMaintenance } from '../src/scripts/maintenance.js'
import { serverPort } from './helpers/server.js'

const apiToken = 'maintenance-client-auth-token-123456'
const token = 'maintenance-client-attempt-123456'

test('maintenance client waits for busy work and obtains a sealed handoff', { timeout: 3000 }, async (t) => {
  const lifecycle = createLifecycle()
  const finish = lifecycle.admit('restarts')
  const server = createApp({ apiToken, maxUploadBytes: 1024, maxRequestBytes: 4096, uploadTimeoutMs: 1000, requestTimeoutMs: 2000 }, {
    lifecycle,
    fallbacks: { async upload() { throw new Error('unused') } },
    management: { async getAllServersStatus() { return {} }, async getServerStatus() { throw new Error('unused') }, async restartServer() { throw new Error('unused') }, getOperation() { return null } },
    deployments: { async doesServerExist() { return true }, async wantsNewArtifacts() { return { game: true, byond: false, rustg: false } }, async beginUpload() { throw new Error('unused') } },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { finish(); server.close(); server.closeAllConnections() })
  const options = { apiToken, token, url: `http://127.0.0.1:${serverPort(server)}`, timeoutMs: 2000, pollMs: 5 }
  let sealed = false
  const pending = runMaintenance('wait', options).then((status) => { sealed = true; return status })
  while (lifecycle.status().mode === 'running') await delay(1)
  await delay(20)
  assert.equal(sealed, false)
  finish()
  assert.equal((await pending).mode, 'sealed')
  await runMaintenance('resume', options)
  assert.equal(lifecycle.status().mode, 'running')
  assert.equal((await runMaintenance('ready', options)).mode, 'running')
})

test('maintenance client refuses malformed or unsupported servers', async (t) => {
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}') })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.close(); server.closeAllConnections() })
  await assert.rejects(runMaintenance('wait', { apiToken, token, url: `http://127.0.0.1:${serverPort(server)}`, timeoutMs: 500, pollMs: 5 }), /maintenance response/i)
})
