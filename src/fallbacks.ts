import fs from 'node:fs/promises'
import path from 'node:path'
import { unpackUpload, type ArchiveFile } from './archive.js'
import { createCommandRunner } from './command.js'
import type { Config } from './config.js'
import { HttpError, errorCode } from './errors.js'
import { createLocks } from './locks.js'
import type { ServiceDependencies } from './services.js'
import { identifier, managedPath } from './validation.js'

type FallbackConfig = Pick<Config, 'serversRoot' | 'commandTimeoutMs' | 'maxUploadBytes' | 'maxExtractedBytes' | 'maxArchiveEntries' | 'gameUserOwner' | 'gameUserGroup'>
export interface FallbackService {
  upload(file: ArchiveFile, options?: { signal?: AbortSignal }): Promise<{ servers: string[] }>
}
interface Replacement { server: string; source: string; target: string; directory?: string; backup?: string; published?: boolean; preserve?: boolean }
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
  return stat
}

export function createFallbackService(config: FallbackConfig, {
  run = createCommandRunner(config.commandTimeoutMs), locks = createLocks(), onError = () => {},
}: ServiceDependencies = {}): FallbackService {
  return { async upload(file, { signal } = {}) {
    signal?.throwIfAborted()
    const archiveDirectory = await fs.mkdtemp(path.join(config.serversRoot, '.overseer-fallback-'))
    const replacements: Replacement[] = []
    let release: (() => void) | undefined
    try {
      const contents = await unpackUpload(file, config, archiveDirectory, 'tar.gz', run, signal,
        (error) => onError(error, { action: 'fallback-extract' }))
      const entries = await fs.readdir(contents, { withFileTypes: true })
      if (!entries.length) throw new HttpError(400, 'No databases supplied')
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.sqlite')) throw new HttpError(400, 'Expected root-level <server>.sqlite files')
        const server = identifier(entry.name.slice(0, -'.sqlite'.length))
        replacements.push({ server, source: path.join(contents, entry.name), target: '' })
      }
      release = locks.acquire(replacements.map(({ server }) => `server:${server}`))
      // Validate every destination before staging or publishing any replacement.
      for (const item of replacements) {
        signal?.throwIfAborted()
        const game = await managedPath(config.serversRoot, item.server, 'game')
        const stat = await statOrMissing(game)
        if (!stat?.isDirectory()) throw new HttpError(404, `Server not found: ${item.server}`)
        item.target = await managedPath(game, 'data', 'fallback.sqlite')
        await checkTarget(item.target)
      }
      for (const item of replacements) {
        signal?.throwIfAborted()
        const data = path.dirname(item.target)
        try {
          await fs.mkdir(data, { mode: 0o770 })
          await fs.chown(data, config.gameUserOwner, config.gameUserGroup)
          await fs.chmod(data, 0o770)
        } catch (error) { if (errorCode(error) !== 'EEXIST') throw error }
        item.directory = await fs.mkdtemp(path.join(data, '.overseer-fallback-'))
        const replacement = path.join(item.directory, 'replacement.sqlite')
        await fs.copyFile(item.source, replacement)
        await fs.chown(replacement, config.gameUserOwner, config.gameUserGroup)
        await fs.chmod(replacement, 0o660)
        if (await checkTarget(item.target)) {
          const backup = path.join(item.directory, 'previous.sqlite')
          await fs.link(item.target, backup)
          item.backup = backup
        }
      }
      for (const item of replacements) {
        signal?.throwIfAborted()
        await managedPath(config.serversRoot, item.server, 'game', 'data', 'fallback.sqlite')
        await checkTarget(item.target)
        await fs.rename(path.join(item.directory!, 'replacement.sqlite'), item.target)
        item.published = true
        signal?.throwIfAborted()
      }
      return { servers: replacements.map(({ server }) => server) }
    } catch (error) {
      for (const item of [...replacements].reverse()) {
        if (!item.published) continue
        try {
          if (item.backup) await fs.rename(item.backup, item.target)
          else await fs.unlink(item.target)
        } catch (rollbackError) {
          item.preserve = true
          onError(rollbackError, { action: 'fallback-rollback', server: item.server, recoveryDirectory: item.directory })
        }
      }
      throw error
    } finally {
      try {
        const cleanup = await Promise.allSettled([
          fs.rm(archiveDirectory, { recursive: true, force: true }),
          ...replacements.filter((item) => item.directory && !item.preserve).map((item) => fs.rm(item.directory!, { recursive: true, force: true })),
        ])
        for (const result of cleanup) if (result.status === 'rejected') onError(result.reason, { action: 'fallback-cleanup' })
      } finally { release?.() }
    }
  } }
}
