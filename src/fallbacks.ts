import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Config } from './config.js'
import { HttpError, errorCode } from './errors.js'
import { createLocks } from './locks.js'
import type { ServiceDependencies } from './services.js'
import { identifier, managedPath } from './validation.js'

type FallbackConfig = Pick<Config, 'serversRoot' | 'maxUploadBytes' | 'gameUserOwner' | 'gameUserGroup'>
export interface FallbackService {
  upload(server: string, file: Readable, options?: { signal?: AbortSignal }): Promise<{ server: string }>
}
async function statOrMissing(target: string) {
  try { return await fs.lstat(target) }
  catch (error) { if (errorCode(error) !== 'ENOENT') throw error; return undefined }
}
async function checkTarget(target: string) {
  const stat = await statOrMissing(target)
  if (stat && !stat.isFile()) throw new HttpError(400, 'Fallback target must be a regular file')
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (await statOrMissing(target + suffix)) throw new HttpError(409, 'Fallback database has SQLite sidecar files')
  }
}

export function createFallbackService(config: FallbackConfig, {
  locks = createLocks(), onError = () => {},
}: Pick<ServiceDependencies, 'locks' | 'onError'> = {}): FallbackService {
  return { async upload(server, file, { signal } = {}) {
    identifier(server)
    signal?.throwIfAborted()
    const release = locks.acquire([`server:${server}`])
    let directory: string | undefined
    try {
      const game = await managedPath(config.serversRoot, server, 'game')
      if (!(await statOrMissing(game))?.isDirectory()) throw new HttpError(404, 'Server not found')
      const target = await managedPath(game, 'data', 'fallback.sqlite')
      await checkTarget(target)
      const data = path.dirname(target)
      try {
        await fs.mkdir(data, { mode: 0o770 })
        await fs.chown(data, config.gameUserOwner, config.gameUserGroup)
        await fs.chmod(data, 0o770)
      } catch (error) { if (errorCode(error) !== 'EEXIST') throw error }
      directory = await fs.mkdtemp(path.join(data, '.overseer-fallback-'))
      const replacement = path.join(directory, 'replacement.sqlite')
      let received = 0
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length
          callback(received > config.maxUploadBytes ? new HttpError(413, 'File exceeds upload size limit') : null, chunk)
        },
      })
      await pipeline(file, limiter, createWriteStream(replacement, { flags: 'wx', mode: 0o600 }), { signal })
      await fs.chown(replacement, config.gameUserOwner, config.gameUserGroup)
      await fs.chmod(replacement, 0o660)
      await managedPath(config.serversRoot, server, 'game', 'data', 'fallback.sqlite')
      await checkTarget(target)
      signal?.throwIfAborted()
      // One atomic rename commits the upload; the old file remains intact until then.
      await fs.rename(replacement, target)
      return { server }
    } finally {
      try {
        if (directory) await fs.rm(directory, { recursive: true, force: true })
      } catch (error) { onError(error, { action: 'fallback-cleanup', server, directory }) }
      finally { release() }
    }
  } }
}
