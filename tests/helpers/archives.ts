import yazl from 'yazl'
import tar, { type Header } from 'tar-stream'
import { gzipSync } from 'node:zlib'
import { buffer } from 'node:stream/consumers'

// Use library writers for fixtures. Patch ZIP names after generation so malicious
// paths can be tested even though the writer rightly refuses to generate them.
export type ArchiveOptions = Partial<Pick<Header, 'type' | 'mode' | 'linkname' | 'pax'>> & { compress?: boolean }
export type ArchiveEntry = [name: string, body: string, options?: ArchiveOptions]

export async function createArchive(entries: ArchiveEntry[], format = 'zip') {
  if (format === 'zip') {
    const zip = new yazl.ZipFile()
    const result = buffer(zip.outputStream)
    const names = []
    for (const [name, body, options = {}] of entries) {
      const directory = options.type === 'directory'
      const filename = Buffer.from(name)
      const safe = 'x'.repeat(filename.length - (directory ? 1 : 0)) + (directory ? '/' : '')
      names.push(filename)
      if (directory) zip.addEmptyDirectory(safe, options)
      else zip.addBuffer(Buffer.from(body), safe, options)
    }
    zip.end()
    const data = await result
    let offset = data.readUInt32LE(data.length - 6)
    for (const name of names) {
      const filenameLength = data.readUInt16LE(offset + 28)
      const extraLength = data.readUInt16LE(offset + 30)
      const commentLength = data.readUInt16LE(offset + 32)
      const local = data.readUInt32LE(offset + 42)
      name.copy(data, offset + 46)
      name.copy(data, local + 30)
      offset += 46 + filenameLength + extraLength + commentLength
    }
    return data
  }
  const pack = tar.pack()
  const result = buffer(pack)
  for (const [name, body, options = {}] of entries) {
    const data = !options.type || options.type === 'file' ? Buffer.from(body) : Buffer.alloc(0)
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name, size: data.length, ...options }, data, (error) => error ? reject(error) : resolve())
    })
  }
  pack.finalize()
  return gzipSync(await result)
}
