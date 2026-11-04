import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createFallbackService } from '../src/fallbacks.js'
import { loadConfig } from '../src/config.js'
import { createLocks } from '../src/locks.js'

async function fixture(t: TestContext, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overseer-fallbacks-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = { ...loadConfig({ API_TOKEN: 'a'.repeat(32), SERVERS_ROOT: root, GAME_USER_OWNER: String(process.getuid!()), GAME_USER_GROUP: String(process.getgid!()) }), ...overrides }
  for (const name of ['main1', 'main2']) await fs.mkdir(path.join(root, name, 'game'), { recursive: true })
  const locks = createLocks()
  return { root, config, locks, service: createFallbackService(config, { locks }), target: (server: string) => path.join(root, server, 'game/data/fallback.sqlite') }
}
const stream = (data: string) => Readable.from([Buffer.from(data)])

test('single database upload creates data directory and atomically replaces only its server fallback', async (t) => {
  const { service, target, config } = await fixture(t)
  assert.deepEqual(await service.upload('main1', stream('first database')), { server: 'main1' })
  await fs.writeFile(path.join(path.dirname(target('main1')), 'unrelated'), 'keep')
  await service.upload('main1', stream('replacement'))
  assert.equal(await fs.readFile(target('main1'), 'utf8'), 'replacement')
  assert.equal(await fs.readFile(path.join(path.dirname(target('main1')), 'unrelated'), 'utf8'), 'keep')
  await assert.rejects(fs.access(target('main2')), { code: 'ENOENT' })
  const stat = await fs.stat(target('main1'))
  assert.equal(stat.mode & 0o7777, 0o660)
  assert.equal(stat.uid, config.gameUserOwner)
  assert.equal(stat.gid, config.gameUserGroup)
  assert.deepEqual((await fs.readdir(path.dirname(target('main1')))).sort(), ['fallback.sqlite', 'unrelated'])
})

test('invalid or unknown server and shared server locks prevent publication', async (t) => {
  const { service, locks, target } = await fixture(t)
  await assert.rejects(service.upload('../main1', stream('bad')), { statusCode: 400 })
  await assert.rejects(service.upload('unknown', stream('bad')), { statusCode: 404 })
  const unlock = locks.acquire(['server:main1'])
  try { await assert.rejects(service.upload('main1', stream('bad')), { statusCode: 409 }) }
  finally { unlock() }
  await assert.rejects(fs.access(target('main1')), { code: 'ENOENT' })
  await service.upload('main1', stream('retry'))
})

test('symlink targets and existing SQLite sidecars are never overwritten', async (t) => {
  const { root, service, target } = await fixture(t)
  await fs.mkdir(path.dirname(target('main1')))
  const outside = path.join(root, 'outside')
  await fs.writeFile(outside, 'keep')
  await fs.symlink(outside, target('main1'))
  await assert.rejects(service.upload('main1', stream('new')), { statusCode: 400 })
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep')
  await fs.unlink(target('main1'))
  for (const suffix of ['-wal', '-shm', '-journal']) {
    await fs.writeFile(target('main1') + suffix, 'sidecar')
    await assert.rejects(service.upload('main1', stream('new')), { statusCode: 409 })
    await fs.unlink(target('main1') + suffix)
  }
})

test('size limits, stream failures, and cancellation retain the previous file and release locks', async (t) => {
  const { service, target, locks } = await fixture(t, { maxUploadBytes: 8 })
  await service.upload('main1', stream('previous'))
  await assert.rejects(service.upload('main1', stream('oversized')), { statusCode: 413 })
  const broken = Readable.from((async function* () { yield Buffer.from('part'); throw new Error('broken upload') })())
  await assert.rejects(service.upload('main1', broken), /broken upload/)
  const controller = new AbortController()
  const cancelled = Readable.from((async function* () { yield Buffer.from('part'); controller.abort(new Error('cancelled')) })())
  await assert.rejects(service.upload('main1', cancelled, { signal: controller.signal }))
  assert.equal(await fs.readFile(target('main1'), 'utf8'), 'previous')
  assert.deepEqual(await fs.readdir(path.dirname(target('main1'))), ['fallback.sqlite'])
  locks.acquire(['server:main1'])()
})

test('rename failure retains the old database and removes staging', async (t) => {
  const { service, target } = await fixture(t)
  await service.upload('main1', stream('previous'))
  t.mock.method(fs, 'rename', async () => { throw new Error('disk failure') })
  await assert.rejects(service.upload('main1', stream('new')), /disk failure/)
  assert.equal(await fs.readFile(target('main1'), 'utf8'), 'previous')
  assert.deepEqual(await fs.readdir(path.dirname(target('main1'))), ['fallback.sqlite'])
})

test('successful rename is the commit boundary even if cancellation arrives during it', async (t) => {
  const { service, target } = await fixture(t)
  await service.upload('main1', stream('previous'))
  const controller = new AbortController()
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args)
    controller.abort(new Error('cancelled after commit'))
  })
  assert.deepEqual(await service.upload('main1', stream('new'), { signal: controller.signal }), { server: 'main1' })
  assert.equal(await fs.readFile(target('main1'), 'utf8'), 'new')
})
