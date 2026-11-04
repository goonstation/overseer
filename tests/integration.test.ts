import { createFallbackService } from '../src/fallbacks.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { serverPort } from './helpers/server.js'
import { createManagementService } from '../src/management.js'
import { once } from 'node:events'
import { createArchive } from './helpers/archives.js'
import { createApp } from '../src/app.js'
import { createDeploymentService } from '../src/deployments.js'
import { loadConfig } from '../src/config.js'

test('real HTTP multipart uploads publish files and rejected archives leave the prior build intact', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overseer-integration-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = loadConfig({
    API_TOKEN: 'a'.repeat(32), SERVERS_ROOT: path.join(root, 'servers'),
    BYOND_ROOT: path.join(root, 'byond'), RUSTG_ROOT: path.join(root, 'rustg'),
    GAME_USER_OWNER: String(process.getuid!()), GAME_USER_GROUP: String(process.getgid!()),
  })
  const game = path.join(config.serversRoot, 'alpha', 'game')
  await fs.mkdir(game, { recursive: true })
  await fs.writeFile(path.join(game, '.env.build'), 'BUILDSTAMP=10\n')
  const archive = await createArchive([['.env.build', 'BUILDSTAMP=20\n'], ['game.dmb', 'compiled game']])
  const server = createApp(config, { management: createManagementService(config, { async run() { assert.fail('integration upload must not invoke Docker') } }), deployments: createDeploymentService(config), fallbacks: createFallbackService(config) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  const url = `http://127.0.0.1:${serverPort(server)}`
  const headers = { Authorization: `Bearer ${config.apiToken}` }
  async function send(data: Uint8Array<ArrayBuffer>) {
    const form = new FormData()
    form.set('build', new Blob([data], { type: 'application/zip' }), 'build.zip')
    return fetch(url + '/build/upload?server=alpha', { method: 'POST', headers, body: form })
  }
  assert.equal((await send(archive)).status, 200)
  assert.equal(await fs.readFile(path.join(game, 'update', 'game.dmb'), 'utf8'), 'compiled game')
  assert.equal((await send(Buffer.from('corrupt zip'))).status, 400)
  assert.equal(await fs.readFile(path.join(game, 'update', 'game.dmb'), 'utf8'), 'compiled game')
  const response = await fetch(url + '/build/check?server=alpha&buildstamp=20&byond=516&rustg=3.4', { headers })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { outdated: { game: false, byond: true, rustg: true } })
  assert.deepEqual((await fs.readdir(game)).sort(), ['.env.build', 'update'])
})

test('real HTTP fallback archive installs server databases and rejects a mixed unknown-server batch', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overseer-fallback-http-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = loadConfig({ API_TOKEN: 'a'.repeat(32), SERVERS_ROOT: root,
    GAME_USER_OWNER: String(process.getuid!()), GAME_USER_GROUP: String(process.getgid!()),
  })
  for (const id of ['main1', 'main2']) await fs.mkdir(path.join(root, id, 'game'), { recursive: true })
  const server = createApp(config, {
    management: createManagementService(config), deployments: createDeploymentService(config),
    fallbacks: createFallbackService(config),
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  const url = `http://127.0.0.1:${serverPort(server)}/fallback/upload`
  const headers = { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/gzip' }
  const send = async (entries: [string, string][]) => fetch(url, { method: 'POST', headers, body: await createArchive(entries, 'tar.gz') })
  const response = await send([['main1.sqlite', 'database one'], ['main2.sqlite', 'database two']])
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { message: 'Success', servers: ['main1', 'main2'] })
  const target = path.join(root, 'main1/game/data/fallback.sqlite')
  assert.equal(await fs.readFile(target, 'utf8'), 'database one')
  assert.equal(await fs.readFile(path.join(root, 'main2/game/data/fallback.sqlite'), 'utf8'), 'database two')
  assert.equal((await send([['main1.sqlite', 'replacement'], ['missing.sqlite', 'bad']])).status, 404)
  assert.equal(await fs.readFile(target, 'utf8'), 'database one')
  assert.equal((await fetch(url, { method: 'POST', headers, body: 'invalid gzip' })).status, 400)
})
