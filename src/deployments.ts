import fs from 'node:fs/promises'
import path from 'node:path'
import { unpackUpload, type ArchiveFile } from './archive.js'
import { HttpError, errorCode } from './errors.js'
import { identifier, buildstamp, managedPath } from './validation.js'
import { createLocks } from './locks.js'
import { createCommandRunner } from './command.js'
import type { Config } from './config.js'
import type { ServiceDependencies } from './services.js'

export type DeploymentConfig = Pick<Config, 'serversRoot' | 'byondRoot' | 'rustgRoot' | 'commandTimeoutMs' | 'gameUserOwner' | 'gameUserGroup' | 'maxUploadBytes' | 'maxExtractedBytes' | 'maxArchiveEntries'>
export type UploadFile = ArchiveFile
export interface UploadInfo { mimeType: string }
export interface UploadSession {
  add(name: string, file: UploadFile, info: UploadInfo): Promise<void>
  commit(): Promise<void>
  abort(): Promise<void>
}
export interface ArtifactNeeds { game: boolean; byond: boolean; rustg: boolean }
export interface DeploymentService {
  doesServerExist(server: string): Promise<boolean>
  wantsNewArtifacts(server: string, stamp: number, byond: string, rustg: string): Promise<ArtifactNeeds>
  beginUpload(server: string, options?: { signal?: AbortSignal }): Promise<UploadSession>
}
interface StagedArtifact { name: string; directory: string; root: string; source: string; preserve?: boolean }
interface ArtifactMove { item: StagedArtifact; source: string; target: string; replace?: boolean; backup?: string; activated?: boolean }


const formats: Record<string, string | undefined> = { 'application/zip': 'zip', 'application/gzip': 'tar.gz' }
const exists = async (target: string) => {
  try { await fs.lstat(target); return true }
  catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error }
}

export function createDeploymentService(config: DeploymentConfig, {
  run = createCommandRunner(config.commandTimeoutMs), locks = createLocks(), onError = () => {},
}: ServiceDependencies = {}): DeploymentService {
  async function serverPath(server: string) {
    identifier(server)
    const target = await managedPath(config.serversRoot, server, 'game')
    try {
      if (!(await fs.stat(target)).isDirectory()) throw new HttpError(404, 'Server not found')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw new HttpError(404, 'Server not found')
      throw error
    }
    return target
  }

  async function doesServerExist(server: string) {
    try { await serverPath(server); return true }
    catch (error) { if (error instanceof HttpError && error.statusCode === 404) return false; throw error }
  }

  async function getBuildStamp(server: string, update = false) {
    const game = await serverPath(server)
    const filename = update
      ? await managedPath(game, 'update', '.env.build')
      : await managedPath(game, '.env.build')
    try {
      const file = await fs.open(filename, 'r')
      try {
        if ((await file.stat()).size > 64 * 1024) throw new HttpError(500, 'Build metadata is too large')
        const text = await file.readFile('utf8')
        const match = text.match(/^\s*BUILDSTAMP\s*=\s*["']?(\d+)["']?\s*$/im)
        return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : 0
      } finally { await file.close() }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 0
      throw error
    }
  }

  async function runtimePath(root: string, version: string) {
    identifier(version, 'version')
    await fs.mkdir(root, { recursive: true })
    return managedPath(root, version)
  }

  async function wantsNewArtifacts(server: string, stamp: number, byond: string, rustg: string) {
    stamp = buildstamp(stamp)
    identifier(byond, 'byond version')
    identifier(rustg, 'rustg version')
    const current = await getBuildStamp(server)
    const pending = await getBuildStamp(server, true)
    return {
      game: stamp > Math.max(current, pending),
      byond: !(await exists(await runtimePath(config.byondRoot, byond))),
      rustg: !(await exists(await runtimePath(config.rustgRoot, rustg))),
    }
  }

  async function beginUpload(server: string, { signal }: { signal?: AbortSignal } = {}): Promise<UploadSession> {
    identifier(server)
    const releases = [locks.acquire([`server:${server}`])]
    const release = () => { for (const unlock of releases.splice(0).reverse()) unlock() }
    const staged: StagedArtifact[] = []
    const tasks = new Set<Promise<void>>()
    const names = new Set<string>()
    let closed = false
    let failure: unknown
    let game: string
    try { game = await serverPath(server) }
    catch (error) { release(); throw error }

    const checkOpen = () => {
      signal?.throwIfAborted()
      if (closed) throw new HttpError(409, 'Upload session is closed')
      if (failure) throw failure
    }
    async function cleanup() {
      try {
        await Promise.all(staged.filter((item) => !item.preserve).map((item) =>
          fs.rm(item.directory, { recursive: true, force: true })))
      } finally { release() }
    }

    async function stage(name: string, file: UploadFile, info: UploadInfo) {
      checkOpen()
      if (!['build', 'byond', 'rustg'].includes(name) || names.has(name)) {
        throw new HttpError(400, 'Unknown or duplicate artifact field')
      }
      names.add(name)
      const format = formats[info.mimeType]
      if (!format) throw new HttpError(415, 'Unsupported archive type')
      // Runtime roots are shared across servers. Reserve only fields present in this request.
      if (name !== 'build') releases.push(locks.acquire([`runtime:${name}`]))
      const root = name === 'build' ? game : name === 'byond' ? config.byondRoot : config.rustgRoot
      await fs.mkdir(root, { recursive: true })
      // Staging on the destination filesystem makes publication via rename atomic.
      const directory = await fs.mkdtemp(path.join(root, '.overseer-stage-'))
      const item = { name, directory, root, source: path.join(directory, 'contents') }
      staged.push(item)
      await unpackUpload(file, config, directory, format, run, signal,
        (error) => onError(error, { action: 'extract', server, artifact: name }))
      checkOpen()
    }

    function add(name: string, file: UploadFile, info: UploadInfo) {
      const task = stage(name, file, info).catch((error) => {
        failure ??= error
        // A rejected field must still be consumed so multipart parsing can finish.
        file.resume()
        throw error
      })
      tasks.add(task)
      // Attach a handler immediately; commit/abort still observe the original failure.
      task.catch(() => {})
      return task
    }

    async function abort() {
      if (closed) return
      closed = true
      await Promise.allSettled(tasks)
      await cleanup()
    }

    async function commit() {
      const published: ArtifactMove[] = []
      try {
        await Promise.allSettled(tasks)
        checkOpen()
        if (!staged.length) throw new HttpError(400, 'No artifacts supplied')
        const moves: ArtifactMove[] = []
        for (const item of staged) {
          if (item.name === 'build') {
            const target = await managedPath(game, 'update')
            moves.push({ item, source: item.source, target, replace: true })
          } else {
            const versions = await fs.readdir(item.source, { withFileTypes: true })
            for (const version of versions) {
              identifier(version.name, 'runtime version')
              if (!version.isDirectory()) throw new HttpError(400, 'Runtime archives must contain version directories')
              const target = await managedPath(item.root, version.name)
              if (await exists(target)) throw new HttpError(409, 'Runtime version already exists')
              moves.push({ item, source: path.join(item.source, version.name), target })
            }
          }
        }
        for (const move of moves) {
          signal?.throwIfAborted()
          // Keep an existing update until the whole request has published successfully.
          if (move.replace && await exists(move.target)) {
            move.backup = path.join(move.item.directory, 'previous')
            await fs.rename(move.target, move.backup)
          }
          published.push(move)
          await fs.rename(move.source, move.target)
          move.activated = true
          signal?.throwIfAborted()
        }
        closed = true
      } catch (error) {
        // Undo in reverse order. Preserve recovery files if rollback itself fails.
        for (const move of published.reverse()) {
          try {
            if (move.activated) await fs.rename(move.target, move.source)
            if (move.backup) await fs.rename(move.backup, move.target)
          } catch (rollbackError) {
            move.item.preserve = true
            onError(rollbackError, { action: 'rollback', server, recoveryDirectory: move.item.directory })
          }
        }
        throw error
      } finally {
        closed = true
        await cleanup()
      }
    }
    return { add, commit, abort }
  }

  return { doesServerExist, wantsNewArtifacts, beginUpload }
}
