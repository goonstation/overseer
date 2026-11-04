import test from 'node:test'
import assert from 'node:assert/strict'

test('startup fails closed on missing authentication or invalid resource configuration', async () => {
  const { loadConfig } = await import('../src/config.js')
  assert.throws(() => loadConfig({}), /API_TOKEN/)
  assert.throws(() => loadConfig({ API_TOKEN: 'short' }), /API_TOKEN/)
  const env = { API_TOKEN: 'a'.repeat(32) }
  for (const key of ['SERVER_PORT', 'MAX_UPLOAD_BYTES', 'UPLOAD_TIMEOUT_MS', 'MAX_ARCHIVE_ENTRIES']) {
    assert.throws(() => loadConfig({ ...env, [key]: '-1' }))
    assert.throws(() => loadConfig({ ...env, [key]: '100garbage' }))
  }
  const config = loadConfig(env)
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 8564)
  assert.ok(config.maxRequestBytes > config.maxUploadBytes)
})
