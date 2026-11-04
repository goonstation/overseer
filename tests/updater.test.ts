import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const script = fileURLToPath(new URL('../../scripts/update-overseer.sh', import.meta.url))
async function fixture(t: TestContext, scenario: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overseer-updater-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const stateFile = path.join(root, 'docker-state.json')
  await fs.writeFile(stateFile, JSON.stringify({ scenario, current: 'a'.repeat(64), modes: { ['a'.repeat(64)]: 'running' }, events: [] }))
  const binary = path.join(root, 'docker')
  await fs.writeFile(binary, `#!${process.execPath}\n` + await fs.readFile(new URL('./helpers/fake-docker.js', import.meta.url), 'utf8'), { mode: 0o700 })
  const env = { ...process.env, PATH: root + path.delimiter + process.env.PATH, OVERSEER_TEST_DOCKER_STATE: stateFile, OVERSEER_UPDATE_STATE_DIR: path.join(root, 'journal') }
  return {
    root, env,
    run: () => exec('bash', [script], { env, timeout: 10000 }),
    read: async () => JSON.parse(await fs.readFile(stateFile, 'utf8')) as { events: string[]; modes: Record<string, string>; current: string },
  }
}

test('updater pulls first and replaces only after Overseer is idle and sealed', async (t) => {
  const setup = await fixture(t, 'healthy')
  await setup.run()
  const state = await setup.read()
  assert.ok(state.events.indexOf('pull') < state.events.indexOf('old:wait'))
  assert.ok(state.events.indexOf('old:sealed') < state.events.indexOf('replace'))
  assert.ok(state.events.includes('new:await-ready'))
  await assert.rejects(fs.access(path.join(setup.root, 'journal', 'attempt')), { code: 'ENOENT' })
})

test('failed drain resumes the existing service without replacement', async (t) => {
  const setup = await fixture(t, 'drain-fail')
  await assert.rejects(setup.run())
  const state = await setup.read()
  assert.equal(state.events.includes('replace'), false)
  assert.equal(state.modes['a'.repeat(64)], 'running')
})

test('failed resume retains the recovery journal', async (t) => {
  const setup = await fixture(t, 'resume-fail')
  await assert.rejects(setup.run())
  const state = await setup.read()
  assert.equal(state.events.includes('replace'), false)
  await fs.access(path.join(setup.root, 'journal', 'attempt'))
})

test('rollback drains the replacement before stopping it', async (t) => {
  const setup = await fixture(t, 'unhealthy')
  await assert.rejects(setup.run())
  const state = await setup.read()
  assert.ok(state.events.includes('rollback'))
  assert.ok(state.events.indexOf('new:wait') < state.events.indexOf('rollback'))
  assert.ok(state.events.indexOf('new:sealed') < state.events.indexOf('rollback'))
  assert.ok(state.events.includes('rollback:await-ready'))
})

test('an unreachable replacement is never stopped without proof it is idle', async (t) => {
  const setup = await fixture(t, 'unreachable')
  await assert.rejects(setup.run())
  const state = await setup.read()
  assert.equal(state.events.includes('rollback'), false)
  await fs.access(path.join(setup.root, 'journal', 'attempt'))
})

test('legacy or unchanged installations are never unnecessarily stopped', async (t) => {
  for (const scenario of ['legacy', 'current']) {
    const setup = await fixture(t, scenario)
    if (scenario === 'legacy') await assert.rejects(setup.run())
    else await setup.run()
    const state = await setup.read()
    assert.equal(state.events.includes('replace'), false)
    assert.equal(state.events.includes('old:wait'), false)
  }
})

test('a subsequent invocation recovers an interrupted replacement before checking for another update', async (t) => {
  const setup = await fixture(t, 'healthy')
  const state = await setup.read()
  state.current = 'c'.repeat(64)
  state.modes[state.current] = 'running'
  await fs.writeFile(path.join(setup.root, 'docker-state.json'), JSON.stringify({ ...state, scenario: 'healthy' }))
  const dir = path.join(setup.root, 'journal')
  await fs.mkdir(dir)
  await fs.writeFile(path.join(dir, 'attempt'), ['a'.repeat(64), 'interrupted-attempt-123456', `sha256:${'1'.repeat(64)}`, 'replacing', ''].join('\n'))
  await setup.run()
  const result = await setup.read()
  assert.ok(result.events.includes('new:await-ready'))
  assert.equal(result.events.includes('replace'), false)
  assert.equal(result.events.includes('pull'), false)
  await assert.rejects(fs.access(path.join(dir, 'attempt')), { code: 'ENOENT' })
})

test('concurrent manual invocations serialize using a kernel lock', async (t) => {
  const setup = await fixture(t, 'slow')
  const first = setup.run()
  await new Promise((resolve) => setTimeout(resolve, 50))
  await Promise.all([first, setup.run()])
  const state = await setup.read()
  assert.equal(state.events.filter((event) => event === 'pull').length, 1)
  assert.equal(state.events.filter((event) => event === 'replace').length, 1)
})
