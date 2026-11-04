import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, crc32 } from 'node:zlib'
import yauzl from 'yauzl'
import tar from 'tar-stream'
import { errorCode, toError } from '../errors.js'

async function* bytes(source: AsyncIterable<unknown>): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new Error('Invalid archive stream')
    yield chunk
  }
}

// This worker writes only into its private staging directory. The parent bounds its
// lifetime and V8 heap; archives are read lazily and file contents are never buffered.
async function extract(archivePath: string, kind: string, destination: string, maxBytes: number, maxEntries: number, uid: number, gid: number) {
  const root = path.resolve(destination)
  const seen = new Set()
  const directories = new Set([root])
  let entries = 0
  let files = 0
  let total = 0

  async function entry(name: string, size: number, directory: boolean, executable: boolean, open: () => NodeJS.ReadableStream | AsyncIterable<Uint8Array> | Promise<NodeJS.ReadableStream | AsyncIterable<Uint8Array>>, expectedCrc?: number) {
    if (++entries > maxEntries) throw new Error('Archive has too many entries')
    if (name.includes('\\') || name.startsWith('/') || name.includes('\0') || Buffer.byteLength(name) > 4096) {
      throw new Error('Unsafe archive path')
    }
    const parts = name.split('/').filter((part) => part !== '' && part !== '.')
    if (parts.some((part) => part === '..' || part.includes(':'))) throw new Error('Unsafe archive path')
    if (!parts.length) {
      if (directory && size === 0) return
      throw new Error('Empty archive path')
    }
    const key = parts.join('/')
    if (seen.has(key)) throw new Error('Duplicate archive path')
    seen.add(key)
    if (!Number.isSafeInteger(size) || size < 0 || total + size > maxBytes || (directory && size !== 0)) {
      throw new Error('Archive exceeds extracted size limit or has an invalid entry size')
    }
    const target = path.join(root, ...parts)
    const parent = directory ? target : path.dirname(target)
    await fs.mkdir(parent, { recursive: true, mode: 0o770 })
    for (let current = parent; current !== root; current = path.dirname(current)) directories.add(current)
    if (directory) return
    let received = 0
    let checksum = 0
    const validate = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length
        total += chunk.length
        if (expectedCrc !== undefined) checksum = crc32(chunk, checksum)
        callback(received > size || total > maxBytes ? new Error('Archive entry exceeds size limit') : null, chunk)
      },
      flush(callback) {
        callback(received !== size || (expectedCrc !== undefined && checksum !== expectedCrc)
          ? new Error('Archive entry size or checksum mismatch') : null)
      },
    })
    await pipeline(await open(), validate, createWriteStream(target, { flags: 'wx', mode: 0o600 }))
    await fs.chmod(target, executable ? 0o770 : 0o660)
    await fs.chown(target, uid, gid)
    files++
  }

  if (kind === 'zip') {
    const zip = await yauzl.openPromise(archivePath, { strictFileNames: true, validateEntrySizes: true })
    try {
      if (zip.entryCount > maxEntries) throw new Error('Archive has too many entries')
      for await (const item of zip.eachEntry()) {
        const mode = item.externalFileAttributes >>> 16
        const type = mode & 0o170000
        const directory = item.fileName.endsWith('/')
        if (type !== 0 && type !== (directory ? 0o040000 : 0o100000)) {
          throw new Error('Links and special files are not allowed')
        }
        if (item.generalPurposeBitFlag & 1) throw new Error('Encrypted archives are not allowed')
        await entry(item.fileName, item.uncompressedSize, directory, Boolean(mode & 0o111),
          () => zip.openReadStreamPromise(item), item.crc32)
      }
    } finally { zip.close() }
  } else if (kind === 'tar.gz') {
    const parser = tar.extract()
    // Count the entire decompressed tar stream as well as file bytes. This bounds
    // hidden metadata records and zero padding that do not produce entry events.
    let tarBytes = 0
    const maxTarBytes = maxBytes + maxEntries * 1024 + 8 * 1024 * 1024
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        tarBytes += chunk.length
        callback(tarBytes > maxTarBytes ? new Error('Archive metadata exceeds size limit') : null, chunk)
      },
    })
    const input = pipeline(createReadStream(archivePath), createGunzip(), limiter, parser)
    input.catch(() => {})
    try {
      for await (const stream of parser) {
        const item = stream.header
        const pax: unknown = item.pax
        if (!['file', 'directory'].includes(item.type) ||
          (typeof pax === 'object' && pax !== null && Object.entries(pax).some(([key, value]) =>
            key.startsWith('GNU.sparse') || key === 'SCHILY.realsize' ||
            (key === 'SCHILY.filetype' && value === 'sparse')))) {
          throw new Error('Links, sparse files and special files are not allowed')
        }
        await entry(item.name, item.size, item.type === 'directory', Boolean(item.mode & 0o111), () => bytes(stream))
        // Directory streams have no data, but must still be consumed before advancing.
        if (item.type === 'directory') for await (const chunk of stream) void chunk
      }
      await input
    } catch (error) {
      parser.destroy(toError(error))
      await input.catch(() => {})
      throw error
    }
  } else { throw new Error('Unsupported archive format') }

  if (!files) throw new Error('Archive contains no files')
  // Include implicit parent directories. Never inherit archive ownership or special bits.
  for (const directory of directories) {
    await fs.chmod(directory, 0o770)
    await fs.chown(directory, uid, gid)
  }
}

try {
  const [archive, kind, destination, ...numbers] = process.argv.slice(2)
  const limits = numbers.map(Number)
  if (!archive || !kind || !destination || limits.length !== 4 || limits.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Invalid extractor configuration')
  }
  await extract(archive, kind, destination, limits[0], limits[1], limits[2], limits[3])
} catch (error) {
  console.error(toError(error).message)
  // Preserve the HTTP distinction between invalid archives and host operational failures.
  const operational = ['EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'EIO', 'EMFILE', 'ENFILE', 'EROFS', 'ENOENT']
  process.exitCode = operational.includes(String(errorCode(error))) ? 1 : 2
}
