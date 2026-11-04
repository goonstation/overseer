import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HttpError, errorCode } from './errors.js'
import type { Config } from './config.js'
import type { CommandRunner } from './command.js'

export type ArchiveFile = Readable & { truncated?: boolean }
type ArchiveConfig = Pick<Config, 'maxUploadBytes' | 'maxExtractedBytes' | 'maxArchiveEntries' | 'gameUserOwner' | 'gameUserGroup'>
const extractor = fileURLToPath(new URL('./scripts/extract_archive.js', import.meta.url))

export async function unpackUpload(file: ArchiveFile, config: ArchiveConfig, directory: string, format: string, run: CommandRunner, signal?: AbortSignal, onError: (error: unknown) => void = () => {}): Promise<string> {
  signal?.throwIfAborted()
  const contents = path.join(directory, 'contents')
  await fs.mkdir(contents, { mode: 0o700 })
  const archive = path.join(directory, 'archive')
  let received = 0
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length
      callback(received > config.maxUploadBytes ? new HttpError(413, 'Archive exceeds upload size limit') : null, chunk)
    },
  })
  await pipeline(file, limiter, createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal })
  if (file.truncated) throw new HttpError(413, 'Archive exceeds upload size limit')
  try {
    await run(process.execPath, ['--max-old-space-size=384', extractor, archive, format, contents,
      String(config.maxExtractedBytes), String(config.maxArchiveEntries),
      String(config.gameUserOwner), String(config.gameUserGroup)], { signal })
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    onError(error)
    if (errorCode(error) === 2) throw new HttpError(400, 'Invalid or unsafe archive')
    throw new HttpError(500, 'Archive extraction failed')
  }
  return contents
}
