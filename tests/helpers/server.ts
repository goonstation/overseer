import assert from 'node:assert/strict'
import type { Server } from 'node:http'

export function serverPort(server: Server): number {
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}
