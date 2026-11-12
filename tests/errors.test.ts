import test from 'node:test'
import assert from 'node:assert/strict'
import { createCommandRunner } from '../src/command.js'
import { errorLogDetails as details } from '../src/errors.js'

test('command failure logs expose the exit code and stderr', async () => {
  try {
    await createCommandRunner(5000)(process.execPath, ['-e',
      'process.stderr.write("/usr/bin/docker: not found\\n"); process.exit(127)'])
    assert.fail('command should fail')
  } catch (error) {
    const log = JSON.parse(JSON.stringify(details(error)))
    assert.equal(log.code, 127)
    assert.equal(log.stderr, '/usr/bin/docker: not found\n')
    assert.match(log.message, /exited unsuccessfully/)
    assert.match(log.stack, /Error:/)
  }
})

test('error logs bound stderr and omit unselected properties', () => {
  const error = Object.assign(new Error('failed'), {
    stderr: 'x'.repeat(5000), stdout: 'private output', env: { API_TOKEN: 'secret' },
    signal: 'SIGKILL', killed: true, code: 'ETIMEDOUT',
  })
  const log = details(error)
  assert.equal(log.stderr, 'x'.repeat(4096))
  assert.equal(log.stderrTruncated, true)
  assert.equal(log.signal, 'SIGKILL')
  assert.equal(log.killed, true)
  assert.equal(log.code, 'ETIMEDOUT')
  assert.equal('stdout' in log, false)
  assert.equal('env' in log, false)
})

test('error logs handle non-Error values and exclude malformed command fields', () => {
  assert.equal(details('failure').message, 'failure')
  const log = details(Object.assign(new Error('failed'), { code: {}, stderr: {}, signal: {} }))
  assert.equal('code' in log, false)
  assert.equal('stderr' in log, false)
  assert.equal('signal' in log, false)
})
