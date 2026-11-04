import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Exercise the emitted executable, rather than importing the HTTP factory.
test('compiled service starts, enforces authentication, and drains on SIGTERM', { timeout: 10000 }, async (t) => {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'overseer-startup-'))
  t.after(() => fs.rm(cwd, { recursive: true, force: true }))
  const child = spawn(process.execPath, [
    '--enable-source-maps', '--env-file-if-exists=.env', fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
  ], {
    cwd,
    env: {
      ...process.env, API_TOKEN: 'a'.repeat(32), SENTRY_DSN: '',
      SERVER_HOST: '127.0.0.1', SERVER_PORT: String(address.port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  const exited = once(child, 'exit')
  let output = ''
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const ready = new Promise<void>((resolve) => child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
    if (output.includes('Server is running')) resolve()
  }))
  await Promise.race([ready, exited.then(() => assert.fail(`service exited before listening: ${stderr}`))])
  const response = await fetch(`http://127.0.0.1:${address.port}/status`)
  assert.equal(response.status, 401)
  child.kill('SIGTERM')
  const [code] = await exited
  assert.equal(code, 0, stderr)
  assert.match(output, /draining requests/)
})
