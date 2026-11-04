import test from 'node:test'
import assert from 'node:assert/strict'
import { createCommandRunner } from '../src/command.js'

test('command arguments are passed literally without shell expansion', async () => {
  const run = createCommandRunner(1000)
  const { stdout } = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'literal;$(echo unsafe)'])
  assert.equal(stdout, 'literal;$(echo unsafe)')
})

test('commands are terminated when they exceed their deadline', async () => {
  const run = createCommandRunner(50)
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)']), (error) => {
    assert.ok(error instanceof Error && 'killed' in error && 'signal' in error)
    assert.equal(error.killed, true)
    assert.equal(error.signal, 'SIGKILL')
    return true
  })
})

test('timeout kills descendants so a failed command cannot continue mutating files', async (t) => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overseer-command-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const marker = path.join(root, 'descendant-ran')
  const childCode = `setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'unsafe'), 250)`
  const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], {stdio:'ignore'}); setInterval(() => {}, 1000)`
  await assert.rejects(createCommandRunner(100)(process.execPath, ['-e', parentCode, childCode, marker]))
  await new Promise((resolve) => setTimeout(resolve, 350))
  await assert.rejects(fs.access(marker), { code: 'ENOENT' })
})

test('command abort cancels running work and output is bounded', async () => {
  const run = createCommandRunner(2000)
  const controller = new AbortController()
  const pending = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { code: 'ABORT_ERR' })
  await assert.rejects(run(process.execPath, ['-e', "process.stdout.write('a'.repeat(2*1024*1024))"]), {
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  })
})
