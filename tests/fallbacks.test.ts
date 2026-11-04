import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createFallbackService } from '../src/fallbacks.js'
import { loadConfig } from '../src/config.js'
import { createLocks } from '../src/locks.js'
import { createArchive } from './helpers/archives.js'

async function fixture(t: TestContext, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overseer-fallbacks-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = { ...loadConfig({ API_TOKEN: 'a'.repeat(32), SERVERS_ROOT: root, GAME_USER_OWNER: String(process.getuid!()), GAME_USER_GROUP: String(process.getgid!()) }), ...overrides }
  for (const name of ['main1', 'main2']) await fs.mkdir(path.join(root, name, 'game'), { recursive: true })
  const locks = createLocks()
  return { root, config, locks, service: createFallbackService(config, { locks }), target: (server: string) => path.join(root, server, 'game/data/fallback.sqlite') }
}
const stream = (data: Buffer) => Readable.from([data])

test('flat database archive maps server IDs and replaces files without disturbing other data', async (t) => {
  const { root, service, target, config } = await fixture(t)
  await fs.mkdir(path.dirname(target('main1')))
  await fs.writeFile(target('main1'), 'previous database')
  await fs.writeFile(path.join(path.dirname(target('main1')), 'unrelated'), 'keep')
  const result = await service.upload(stream(await createArchive([['main1.sqlite', 'database one'], ['main2.sqlite', 'database two']], 'tar.gz')))
  assert.deepEqual(result, { servers: ['main1', 'main2'] })
  assert.equal(await fs.readFile(target('main1'), 'utf8'), 'database one')
  assert.equal(await fs.readFile(target('main2'), 'utf8'), 'database two')
  assert.equal(await fs.readFile(path.join(path.dirname(target('main1')), 'unrelated'), 'utf8'), 'keep')
  for (const name of ['main1', 'main2']) {
    const stat = await fs.stat(target(name))
    assert.equal(stat.mode & 0o7777, 0o660)
    assert.equal(stat.uid, config.gameUserOwner)
    assert.equal(stat.gid, config.gameUserGroup)
    assert.equal((await fs.readdir(path.dirname(target(name)))).some((name) => name.startsWith('.overseer-')), false)
  }
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith('.overseer-')), false)
})

test('unknown server or unexpected archive entries reject the whole batch before replacement', async (t) => {
  const { service, target } = await fixture(t)
  await fs.mkdir(path.dirname(target('main1')))
  await fs.writeFile(target('main1'), 'previous')
  for (const entries of [
    [['main1.sqlite', 'new'], ['unknown.sqlite', 'bad']],
    [['main1.sqlite', 'new'], ['notes.txt', 'bad']],
    [['folder/main1.sqlite', 'bad']],
    [['../main1.sqlite', 'bad']],
  ] satisfies [string, string][][]) {
    await assert.rejects(service.upload(stream(await createArchive(entries, 'tar.gz'))))
    assert.equal(await fs.readFile(target('main1'), 'utf8'), 'previous')
  }
})

test('shared server locks reject conflicting uploads before changing any target', async (t) => {
  const { service, locks, target } = await fixture(t)
  const unlock = locks.acquire(['server:main2'])
  try {
    await assert.rejects(service.upload(stream(await createArchive([['main1.sqlite', 'one'], ['main2.sqlite', 'two']], 'tar.gz'))), { statusCode: 409 })
  } finally { unlock() }
  await assert.rejects(fs.access(target('main1')), { code: 'ENOENT' })
  await service.upload(stream(await createArchive([['main2.sqlite', 'retry']], 'tar.gz')))
})

test('symlink targets and existing SQLite sidecars are never overwritten', async (t) => {
  const { root, service, target } = await fixture(t)
  await fs.mkdir(path.dirname(target('main1')))
  const outside = path.join(root, 'outside')
  await fs.writeFile(outside, 'keep')
  await fs.symlink(outside, target('main1'))
  const archive = await createArchive([['main1.sqlite', 'new']], 'tar.gz')
  await assert.rejects(service.upload(stream(archive)), { statusCode: 400 })
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep')
  await fs.unlink(target('main1'))
  for (const suffix of ['-wal', '-shm', '-journal']) {
    await fs.writeFile(target('main1') + suffix, 'sidecar')
    await assert.rejects(service.upload(stream(archive)), { statusCode: 409 })
    await fs.unlink(target('main1') + suffix)
  }
})

test('publication failure rolls back earlier database replacements', async (t) => {
  const { service, target } = await fixture(t)
  for (const name of ['main1', 'main2']) {
    await fs.mkdir(path.dirname(target(name)))
    await fs.writeFile(target(name), `previous ${name}`)
  }
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (destination === target('main2') && String(source).endsWith('replacement.sqlite')) throw Object.assign(new Error('disk failure'), { code: 'EIO' })
    return rename(source, destination)
  })
  await assert.rejects(service.upload(stream(await createArchive([['main1.sqlite', 'one'], ['main2.sqlite', 'two']], 'tar.gz'))), /disk failure/)
  assert.equal(await fs.readFile(target('main1'), 'utf8'), 'previous main1')
  assert.equal(await fs.readFile(target('main2'), 'utf8'), 'previous main2')
})

test('malformed archives and compressed/extracted limits do not publish databases', async (t) => {
  const { service, target } = await fixture(t, { maxUploadBytes: 512, maxExtractedBytes: 32 })
  await assert.rejects(service.upload(stream(Buffer.from('not gzip'))), { statusCode: 400 })
  await assert.rejects(service.upload(stream(Buffer.alloc(513))), { statusCode: 413 })
  await assert.rejects(service.upload(stream(await createArchive([['main1.sqlite', 'a'.repeat(33)]], 'tar.gz'))), { statusCode: 400 })
  await assert.rejects(fs.access(target('main1')), { code: 'ENOENT' })
})

test('rollback failure preserves the previous database in a recovery directory and releases locks', async (t) => {
  const { config, locks, target } = await fixture(t)
  for (const name of ['main1', 'main2']) {
    await fs.mkdir(path.dirname(target(name)))
    await fs.writeFile(target(name), `previous ${name}`)
  }
  const reports: Record<string, unknown>[] = []
  const service = createFallbackService(config, { locks, onError(error, context) { reports.push(context) } })
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (destination === target('main2') || String(source).endsWith('previous.sqlite')) throw new Error('disk failure')
    return rename(source, destination)
  })
  await assert.rejects(service.upload(stream(await createArchive([['main1.sqlite', 'one'], ['main2.sqlite', 'two']], 'tar.gz'))), /disk failure/)
  const report = reports.find((context) => context.action === 'fallback-rollback')!
  assert.equal(report.server, 'main1')
  assert.equal(await fs.readFile(path.join(String(report.recoveryDirectory), 'previous.sqlite'), 'utf8'), 'previous main1')
  assert.equal(await fs.readFile(target('main2'), 'utf8'), 'previous main2')
  locks.acquire(['server:main1', 'server:main2'])()
})

test('cancellation during the final rename rolls back the replacement', async (t) => {
  const { service, target } = await fixture(t)
  await fs.mkdir(path.dirname(target('main1')))
  await fs.writeFile(target('main1'), 'previous')
  const controller = new AbortController()
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    await rename(source, destination)
    if (String(source).endsWith('replacement.sqlite')) controller.abort(new Error('cancelled at publication'))
  })
  await assert.rejects(service.upload(stream(await createArchive([['main1.sqlite', 'new']], 'tar.gz')), { signal: controller.signal }), /cancelled at publication/)
  assert.equal(await fs.readFile(target('main1'), 'utf8'), 'previous')
})

test('cancellation after commit during cleanup leaves a successful replacement', async (t) => {
  const { service, target } = await fixture(t)
  const controller = new AbortController()
  const remove = fs.rm.bind(fs)
  t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    controller.abort(new Error('cancelled during cleanup'))
    return remove(...args)
  })
  assert.deepEqual(await service.upload(stream(await createArchive([['main1.sqlite', 'new']], 'tar.gz')), { signal: controller.signal }), { servers: ['main1'] })
  assert.equal(await fs.readFile(target('main1'), 'utf8'), 'new')
})
