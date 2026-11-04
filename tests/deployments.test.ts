import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createArchive, type ArchiveEntry } from './helpers/archives.js'
import * as deployments from '../src/deployments.js'
import type { DeploymentConfig, UploadSession } from '../src/deployments.js'

async function fixture(t: TestContext, overrides: Partial<DeploymentConfig> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overseer-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config: DeploymentConfig = {
    serversRoot: path.join(root, 'servers'), byondRoot: path.join(root, 'byond'),
    rustgRoot: path.join(root, 'rustg'), gameUserOwner: process.getuid!(),
    gameUserGroup: process.getgid!(), maxUploadBytes: 1024 * 1024,
    maxExtractedBytes: 1024 * 1024, maxArchiveEntries: 100, commandTimeoutMs: 5000,
    ...overrides,
  }
  await fs.mkdir(path.join(config.serversRoot, 'alpha', 'game', 'update'), { recursive: true })
  await fs.writeFile(path.join(config.serversRoot, 'alpha', 'game', 'update', 'old'), 'previous')
  assert.equal(typeof deployments.createDeploymentService, 'function', 'deployments must expose upload sessions')
  return { root, config, svc: deployments.createDeploymentService(config) }
}
const upload = (session: UploadSession, name: string, data: Buffer, mimeType = 'application/zip') =>
  session.add(name, Readable.from([data]), { mimeType })

test('build is staged until commit, atomically replaces old update, and cleans temporary files', async (t) => {
  const { root, config, svc } = await fixture(t)
  const session = await svc.beginUpload('alpha')
  await upload(session, 'build', await createArchive([['.env.build', 'BUILDSTAMP=20\n'], ['new', 'ready']]))
  const target = path.join(config.serversRoot, 'alpha', 'game', 'update')
  assert.equal(await fs.readFile(path.join(target, 'old'), 'utf8'), 'previous')
  await session.commit()
  assert.equal(await fs.readFile(path.join(target, 'new'), 'utf8'), 'ready')
  await assert.rejects(fs.access(path.join(target, 'old')))
  assert.deepEqual((await fs.readdir(path.dirname(target))).sort(), ['update'])
})

test('bad archive rejects without replacing the old build and releases upload locks', async (t) => {
  const { root, config, svc } = await fixture(t)
  const session = await svc.beginUpload('alpha')
  await assert.rejects(upload(session, 'build', await createArchive([['../outside', 'bad']])), { statusCode: 400 })
  await session.abort()
  assert.equal(await fs.readFile(path.join(config.serversRoot, 'alpha', 'game', 'update', 'old'), 'utf8'), 'previous')
  const retry = await svc.beginUpload('alpha')
  await retry.abort()
  await assert.rejects(fs.access(path.join(config.serversRoot, 'alpha', 'game', 'outside')))
})

test('concurrent uploads conflict and abort cleans staging', async (t) => {
  const { root, config, svc } = await fixture(t)
  const first = await svc.beginUpload('alpha')
  await assert.rejects(svc.beginUpload('alpha'), { statusCode: 409 })
  await upload(first, 'build', await createArchive([['new', 'staged']]))
  await first.abort()
  assert.deepEqual(await fs.readdir(path.join(config.serversRoot, 'alpha', 'game')), ['update'])
})

test('tar runtime versions publish separately and installed versions are immutable', async (t) => {
  const { root, config, svc } = await fixture(t)
  const data = await createArchive([['516.1666/bin/runtime', 'runtime']], 'tar.gz')
  let session = await svc.beginUpload('alpha')
  await upload(session, 'byond', data, 'application/gzip')
  await session.commit()
  assert.equal(await fs.readFile(path.join(config.byondRoot, '516.1666/bin/runtime'), 'utf8'), 'runtime')
  session = await svc.beginUpload('alpha')
  await upload(session, 'byond', data, 'application/gzip')
  await assert.rejects(session.commit(), { statusCode: 409 })
  await session.abort()
})

test('archive extraction and upload size limits reject oversized data', async (t) => {
  const { root, svc } = await fixture(t, { maxExtractedBytes: 32, maxUploadBytes: 500 })
  let session = await svc.beginUpload('alpha')
  await assert.rejects(upload(session, 'build', await createArchive([['big', 'a'.repeat(200)]])), { statusCode: 400 })
  await session.abort()
  session = await svc.beginUpload('alpha')
  await assert.rejects(upload(session, 'build', Buffer.alloc(501)), { statusCode: 413 })
  await session.abort()
})

test('invalid metadata and symlink server roots cannot escape managed paths', async (t) => {
  const { root, config, svc } = await fixture(t)
  await assert.rejects(svc.beginUpload('../alpha'), { statusCode: 400 })
  await fs.symlink(root, path.join(config.serversRoot, 'linked'))
  await assert.rejects(svc.beginUpload('linked'), { statusCode: 400 })
  await assert.rejects(svc.wantsNewArtifacts('alpha', NaN, 'valid', 'valid'), { statusCode: 400 })
  await assert.rejects(svc.wantsNewArtifacts('alpha', 10, '../escape', 'valid'), { statusCode: 400 })
})

test('build checks compare against both live and pending builds and parse ordinary metadata', async (t) => {
  const { config, svc } = await fixture(t)
  const game = path.join(config.serversRoot, 'alpha', 'game')
  await fs.writeFile(path.join(game, '.env.build'), '# comment\nBUILDSTAMP=30\nBYOND=516.1666\n')
  await fs.writeFile(path.join(game, 'update', '.env.build'), 'BUILDSTAMP=20\n')
  const wants = await svc.wantsNewArtifacts('alpha', 25, '516.1666', '3.4.0')
  assert.deepEqual(wants, { game: false, byond: true, rustg: true })
})

test('links and special archive entries are rejected in ZIP and tar', async (t) => {
  const { root, svc } = await fixture(t)
  for (const kind of ['zip', 'tar.gz']) {
    const data = await createArchive([['link', '/tmp/outside', kind === 'zip'
      ? { mode: 0o120777 } : { type: 'symlink', linkname: '/tmp/outside' }]], kind)
    const session = await svc.beginUpload('alpha')
    await assert.rejects(upload(session, 'build', data, kind === 'zip' ? 'application/zip' : 'application/gzip'), { statusCode: 400 })
    await session.abort()
  }
})

test('archive entry count and normalized duplicate paths are bounded', async (t) => {
  const { root, svc } = await fixture(t, { maxArchiveEntries: 2 })
  for (const entries of [
    [['one', '1'], ['two', '2'], ['three', '3']],
    [['one', '1'], ['./one', '2']],
  ] satisfies ArchiveEntry[][]) {
    const session = await svc.beginUpload('alpha')
    await assert.rejects(upload(session, 'build', await createArchive(entries)), { statusCode: 400 })
    await session.abort()
  }
})

test('batch publication rolls back a build if a later rename fails', async (t) => {
  const { root, config, svc } = await fixture(t)
  const session = await svc.beginUpload('alpha')
  await upload(session, 'build', await createArchive([['new', 'new build']]))
  await upload(session, 'rustg', await createArchive([['3.4.0/librust_g.so', 'runtime']]))
  const rename = fs.rename.bind(fs)
  const target = path.join(config.rustgRoot, '3.4.0')
  t.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (destination === target) throw Object.assign(new Error('disk failure'), { code: 'EIO' })
    return rename(source, destination)
  })
  await assert.rejects(session.commit(), /disk failure/)
  assert.equal(await fs.readFile(path.join(config.serversRoot, 'alpha', 'game', 'update', 'old'), 'utf8'), 'previous')
  await assert.rejects(fs.access(target))
  assert.deepEqual(await fs.readdir(path.join(config.serversRoot, 'alpha', 'game')), ['update'])
})

for (const finalArtifact of ['build', 'rustg']) {
  test(`cancellation during the final ${finalArtifact} rename rolls back publication`, async (t) => {
    const { config, svc } = await fixture(t)
    const controller = new AbortController()
    const session = await svc.beginUpload('alpha', { signal: controller.signal })
    t.after(() => session.abort())
    await upload(session, 'build', await createArchive([['new', 'new build']]))
    if (finalArtifact === 'rustg') {
      await upload(session, 'rustg', await createArchive([['3.4.0/librust_g.so', 'runtime']]))
    }
    const game = path.join(config.serversRoot, 'alpha', 'game')
    const target = finalArtifact === 'build' ? path.join(game, 'update') : path.join(config.rustgRoot, '3.4.0')
    const rename = fs.rename.bind(fs)
    t.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
      await rename(source, destination)
      if (destination === target && String(source).includes(`${path.sep}contents`)) {
        controller.abort(new Error('cancelled during publication'))
      }
    })

    await assert.rejects(session.commit(), /cancelled during publication/)
    assert.equal(await fs.readFile(path.join(game, 'update', 'old'), 'utf8'), 'previous')
    assert.deepEqual(await fs.readdir(game), ['update'])
    if (finalArtifact === 'rustg') assert.deepEqual(await fs.readdir(config.rustgRoot), [])
    const retry = await svc.beginUpload('alpha')
    await retry.abort()
  })
}

test('commit waits for all failed/concurrent staging tasks before cleaning directories', async (t) => {
  const { root, config, svc } = await fixture(t)
  const session = await svc.beginUpload('alpha')
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  t.after(() => finish())
  const good = await createArchive([['version/runtime', 'good']])
  async function* slow() { await gate; yield good }
  const slowTask = session.add('byond', Readable.from(slow()), { mimeType: 'application/zip' })
  const bad = session.add('build', Readable.from(['bad zip']), { mimeType: 'application/zip' })
  const commit = session.commit()
  let completed = false
  commit.then(() => { completed = true }, () => { completed = true })
  await assert.rejects(bad)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completed, false, 'cleanup must await every staging task')
  finish()
  await Promise.allSettled([slowTask])
  await assert.rejects(commit)
  assert.deepEqual(await fs.readdir(config.byondRoot), [])
})

test('different servers may stage builds concurrently but overlapping runtime uploads conflict', async (t) => {
  const { root, config, svc } = await fixture(t)
  await fs.mkdir(path.join(config.serversRoot, 'beta', 'game'), { recursive: true })
  const first = await svc.beginUpload('alpha')
  const second = await svc.beginUpload('beta')
  try {
    const build = await createArchive([['game.dmb', 'build']])
    await Promise.all([upload(first, 'build', build), upload(second, 'build', build)])
    const runtime = await createArchive([['516/bin/runtime', 'runtime']])
    await upload(first, 'byond', runtime)
    await assert.rejects(upload(second, 'byond', runtime), { statusCode: 409 })
  } finally { await first.abort(); await second.abort() }
  const retry = await svc.beginUpload('beta')
  await retry.abort()
})

test('uploads use the current Node executable and do not require an external runtime', async (t) => {
  const { root, config } = await fixture(t)
  const { createCommandRunner } = await import('../src/command.js')
  const run = createCommandRunner(config.commandTimeoutMs)
  const svc = deployments.createDeploymentService(config, {
    run(file, args, options) {
      assert.equal(file, process.execPath, 'archive extraction must use Node')
      return run(file, args, options)
    },
  })
  const session = await svc.beginUpload('alpha')
  try {
    await upload(session, 'build', await createArchive([['game.dmb', 'game']]))
    await session.commit()
  } finally { await session.abort() }
  assert.equal(await fs.readFile(path.join(config.serversRoot, 'alpha/game/update/game.dmb'), 'utf8'), 'game')
})

test('Node extraction rejects unsafe paths and special files in both formats', async (t) => {
  const { svc } = await fixture(t)
  for (const format of ['zip', 'tar.gz']) {
    const mime = format === 'zip' ? 'application/zip' : 'application/gzip'
    const cases: ArchiveEntry[][] = [
      [['/absolute', 'bad']], [['../escape', 'bad']], [['dir/../../escape', 'bad']],
      [['dir\\escape', 'bad']], [['C:/escape', 'bad']],
      [['fifo', '', format === 'zip' ? { mode: 0o010644 } : { type: 'fifo' }]],
      [['device', '', format === 'zip' ? { mode: 0o020644 } : { type: 'character-device' }]],
    ]
    if (format === 'tar.gz') {
      cases.push([['link', '', { type: 'link', linkname: '/etc/passwd' }]])
      cases.push([['sparse', 'data', { pax: { 'GNU.sparse.size': '1000000' } }]])
    }
    for (const entries of cases) {
      const session = await svc.beginUpload('alpha')
      try { await assert.rejects(upload(session, 'build', await createArchive(entries, format), mime), { statusCode: 400 }) }
      finally { await session.abort() }
    }
  }
})

test('Node extraction checks ZIP checksums and rejects truncated gzip input', async (t) => {
  const { svc } = await fixture(t)
  const zip = await createArchive([['game.dmb', 'compiled game', { compress: false }]])
  const dataOffset = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28)
  zip[dataOffset] ^= 1
  const tar = await createArchive([['game.dmb', 'compiled game']], 'tar.gz')
  for (const [data, mime] of [[zip, 'application/zip'], [tar.subarray(0, tar.length - 8), 'application/gzip']] satisfies [Buffer, string][]) {
    const session = await svc.beginUpload('alpha')
    try { await assert.rejects(upload(session, 'build', data, mime), { statusCode: 400 }) }
    finally { await session.abort() }
  }
})

test('Node extraction preserves execute permissions and applies configured ownership', async (t) => {
  const { config, svc } = await fixture(t)
  for (const format of ['zip', 'tar.gz']) {
    const session = await svc.beginUpload('alpha')
    await upload(session, 'build', await createArchive([
      ['bin/', '', { type: 'directory', mode: 0o40777 }],
      ['bin/run', 'executable', { mode: 0o107777 }],
      ['data.txt', 'data', { mode: 0o100666 }],
    ], format), format === 'zip' ? 'application/zip' : 'application/gzip')
    await session.commit()
    const target = path.join(config.serversRoot, 'alpha/game/update')
    assert.equal((await fs.stat(path.join(target, 'bin/run'))).mode & 0o7777, 0o770)
    assert.equal((await fs.stat(path.join(target, 'data.txt'))).mode & 0o7777, 0o660)
    assert.equal((await fs.stat(path.join(target, 'bin'))).mode & 0o7777, 0o770)
    assert.equal((await fs.stat(path.join(target, 'bin/run'))).uid, config.gameUserOwner)
    assert.equal((await fs.stat(path.join(target, 'bin/run'))).gid, config.gameUserGroup)
  }
})

test('Node extraction rejects encrypted ZIP entries', async (t) => {
  const { svc } = await fixture(t)
  const data = await createArchive([['file', 'data']])
  const central = data.readUInt32LE(data.length - 6)
  data.writeUInt16LE(data.readUInt16LE(6) | 1, 6)
  data.writeUInt16LE(data.readUInt16LE(central + 8) | 1, central + 8)
  const session = await svc.beginUpload('alpha')
  try { await assert.rejects(upload(session, 'build', data), { statusCode: 400 }) }
  finally { await session.abort() }
})

test('Node extraction bounds decompressed tar metadata and padding as well as file contents', async (t) => {
  const { gzipSync, gunzipSync } = await import('node:zlib')
  const { svc } = await fixture(t, { maxExtractedBytes: 64, maxArchiveEntries: 2 })
  const tar = gunzipSync(await createArchive([['file', 'data']], 'tar.gz'))
  const padded = gzipSync(Buffer.concat([tar, Buffer.alloc(9 * 1024 * 1024)]))
  const session = await svc.beginUpload('alpha')
  try { await assert.rejects(upload(session, 'build', padded, 'application/gzip'), { statusCode: 400 }) }
  finally { await session.abort() }
})
