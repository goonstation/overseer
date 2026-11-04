import { PassThrough } from 'node:stream'
import type { FallbackService } from './fallbacks.js'
import { createLifecycle, type Lifecycle } from './lifecycle.js'
import http, { type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import busboy from 'busboy'
import { HttpError, toError } from './errors.js'
import { identifier, buildstamp } from './validation.js'
import type { Config } from './config.js'
import type { DeploymentService, UploadSession } from './deployments.js'
import type { ManagementService } from './management.js'
import type { ErrorReporter } from './services.js'

export type AppConfig = Pick<Config, 'apiToken' | 'maxUploadBytes' | 'maxRequestBytes' | 'uploadTimeoutMs' | 'requestTimeoutMs'>
export interface AppServices { lifecycle?: Lifecycle; management: ManagementService; deployments: DeploymentService; fallbacks: FallbackService; onError?: ErrorReporter }

function query(params: URLSearchParams, key: string) {
  const values = params.getAll(key)
  if (values.length !== 1 || !values[0]) throw new HttpError(400, `Expected one ${key} parameter`)
  return values[0]
}

async function receiveUpload(req: IncomingMessage, res: ServerResponse, config: AppConfig, deployments: DeploymentService, server: string) {
  if (req.destroyed || req.aborted) throw new HttpError(400, 'Upload disconnected')
  const controller = new AbortController()
  const { signal } = controller
  let session: UploadSession | undefined
  let parser: busboy.Busboy | undefined
  let failure: Error | undefined
  const tasks: Promise<void>[] = []
  const names = new Set<string>()
  const fail = (cause: unknown) => {
    if (failure) return
    const error = toError(cause)
    failure = error
    // Busboy can still be inside a file/limit callback. Destroy after that stack unwinds.
    queueMicrotask(() => {
      controller.abort(error)
      if (parser) {
        req.unpipe(parser)
        parser.destroy(error)
      }
      req.resume()
    })
  }
  const onAborted = () => fail(new HttpError(400, 'Upload disconnected'))
  const onResponseClosed = () => { if (!res.writableEnded) onAborted() }
  const timer = setTimeout(() => fail(new HttpError(408, 'Upload timed out')), config.uploadTimeoutMs)
  timer.unref()
  req.once('aborted', onAborted)
  res.once('close', onResponseClosed)
  let onData: ((chunk: Buffer) => void) | undefined
  try {
    const length = req.headers['content-length']
    if (length && Number(length) > config.maxRequestBytes) throw new HttpError(413, 'Request exceeds upload size limit')
    try {
      parser = busboy({ headers: req.headers, limits: {
        fileSize: config.maxUploadBytes + 1, files: 3, fields: 0, parts: 4,
        fieldNameSize: 100, headerPairs: 100,
      } })
    } catch { throw new HttpError(400, 'Invalid multipart request') }
    parser.on('error', () => {})
    session = await deployments.beginUpload(server, { signal })
    signal.throwIfAborted()
    const currentParser = parser
    const currentSession = session
    const parsed = new Promise<void>((resolve) => {
      currentParser.once('close', resolve)
      currentParser.once('error', (error) => {
        fail(error instanceof HttpError ? error : new HttpError(400, 'Invalid multipart request'))
        resolve()
      })
    })
    parser.on('file', (name, file, info) => {
      file.on('error', () => {})
      if (failure) { file.resume(); return }
      file.on('limit', () => fail(new HttpError(413, 'Archive exceeds upload size limit')))
      if (!['build', 'byond', 'rustg'].includes(name) || names.has(name)) {
        file.resume()
        fail(new HttpError(400, 'Unknown or duplicate artifact field'))
        return
      }
      names.add(name)
      if (!['application/zip', 'application/gzip'].includes(info.mimeType)) {
        file.resume()
        fail(new HttpError(415, 'Unsupported archive type'))
        return
      }
      const task = Promise.resolve().then(() => currentSession.add(name, file, info))
      tasks.push(task)
      task.catch(fail)
    })
    parser.on('field', () => fail(new HttpError(400, 'Text fields are not allowed')))
    parser.on('fieldsLimit', () => fail(new HttpError(400, 'Text fields are not allowed')))
    parser.on('filesLimit', () => fail(new HttpError(400, 'Too many files')))
    parser.on('partsLimit', () => fail(new HttpError(400, 'Too many parts')))
    let received = 0
    onData = (chunk) => {
      received += chunk.length
      if (received > config.maxRequestBytes) fail(new HttpError(413, 'Request exceeds upload size limit'))
    }
    req.on('data', onData)
    req.pipe(parser)
    await parsed
    await Promise.allSettled(tasks)
    if (failure) throw failure
    if (!names.size) throw new HttpError(400, 'No artifacts supplied')
    signal.throwIfAborted()
    await session.commit()
  } catch (error) {
    fail(error)
    await Promise.allSettled(tasks)
    if (session) await session.abort()
    throw failure ?? error
  } finally {
    clearTimeout(timer)
    req.off('aborted', onAborted)
    res.off('close', onResponseClosed)
    if (onData) req.off('data', onData)
    if (parser) {
      req.unpipe(parser)
      // Handle constructor/beginUpload failures before parser listeners were installed.
      parser.on('error', () => {})
      if (!parser.destroyed) parser.destroy()
    }
  }
}

async function receiveFallback(req: IncomingMessage, res: ServerResponse, config: AppConfig, fallbacks: FallbackService, server: string) {
  if (req.destroyed || req.aborted) throw new HttpError(400, 'Upload disconnected')
  const mime = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
  if (!['application/octet-stream', 'application/vnd.sqlite3', 'application/x-sqlite3'].includes(mime ?? '')) {
    throw new HttpError(415, 'Expected a raw SQLite file (application/octet-stream)')
  }
  const limit = Math.min(config.maxUploadBytes, config.maxRequestBytes)
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, 'File exceeds upload size limit')
  // Keep stream failures from destroying the HTTP socket before its JSON error is sent.
  const body = new PassThrough()
  body.on('error', () => {})
  const controller = new AbortController()
  let failure: Error | undefined
  const fail = (cause: unknown) => {
    if (failure) return
    failure = toError(cause)
    controller.abort(failure)
    req.unpipe(body)
    body.destroy(failure)
    req.resume()
  }
  const onAborted = () => fail(new HttpError(400, 'Upload disconnected'))
  const onResponseClosed = () => { if (!res.writableEnded) onAborted() }
  let received = 0
  const onData = (chunk: Buffer) => {
    received += chunk.length
    if (received > limit) fail(new HttpError(413, 'File exceeds upload size limit'))
  }
  const timer = setTimeout(() => fail(new HttpError(408, 'Upload timed out')), config.uploadTimeoutMs)
  timer.unref()
  req.once('aborted', onAborted)
  res.once('close', onResponseClosed)
  req.on('data', onData)
  req.pipe(body)
  try {
    const result = await fallbacks.upload(server, body, { signal: controller.signal })
    // A resolved service has committed; cancellation during cleanup cannot undo it.
    return result
  } catch (error) {
    fail(error)
    throw failure
  } finally {
    clearTimeout(timer)
    req.off('aborted', onAborted)
    res.off('close', onResponseClosed)
    req.off('data', onData)
    req.unpipe(body)
    body.destroy()
  }
}

export function createApp(config: AppConfig, { management, deployments, fallbacks, onError = () => {}, lifecycle = createLifecycle() }: AppServices) {
  if (!config.apiToken) throw new Error('API_TOKEN is required')
  const digest = (value: string) => createHash('sha256').update(value).digest()
  const expected = digest(`Bearer ${config.apiToken}`)
  const server = http.createServer((req, res) => {
    let releaseUpload: (() => void) | undefined
    const send = (status: number, body: unknown, headers: OutgoingHttpHeaders = {}) => {
      if (res.destroyed || res.writableEnded) return
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', ...headers,
      })
      res.end(JSON.stringify(body))
    }
    const handle = async () => {
      if (!timingSafeEqual(expected, digest(req.headers.authorization ?? ''))) {
        send(401, { message: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer', Connection: 'close' })
        req.resume()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const params = url.searchParams
      const methods: Record<string, string | undefined> = {
        '/status': 'GET', '/restart': 'POST', '/build/check': 'GET', '/build/upload': 'POST', '/fallback/upload': 'POST',
        '/maintenance': 'GET', '/maintenance/drain': 'POST', '/maintenance/renew': 'POST', '/maintenance/seal': 'POST', '/maintenance/resume': 'POST',
      }
      const method = methods[url.pathname] ?? (url.pathname.startsWith('/operations/') ? 'GET' : null)
      if (!method) throw new HttpError(404, 'Not found')
      if (req.method !== method) {
        send(405, { message: 'Method not allowed' }, { Allow: method, Connection: 'close' })
        req.resume()
        return
      }
      if (url.pathname === '/maintenance') {
        send(200, lifecycle.status())
      } else if (url.pathname.startsWith('/maintenance/')) {
        const token = req.headers['x-drain-token']
        if (typeof token !== 'string') throw new HttpError(400, 'X-Drain-Token is required')
        const result = url.pathname === '/maintenance/drain' ? lifecycle.drain(token)
          : url.pathname === '/maintenance/renew' ? lifecycle.renew(token)
          : url.pathname === '/maintenance/seal' ? lifecycle.seal(token) : lifecycle.resume(token)
        send(200, result)
      } else if (url.pathname === '/fallback/upload') {
        releaseUpload = lifecycle.admit('uploads')
        const result = await receiveFallback(req, res, config, fallbacks, identifier(query(params, 'server')))
        send(200, { message: 'Success', ...result })
      } else if (url.pathname === '/status') {
        const result = params.has('server')
          ? { [identifier(query(params, 'server'))]: await management.getServerStatus(query(params, 'server')) }
          : await management.getAllServersStatus()
        send(200, result)
      } else if (url.pathname === '/restart') {
        if (lifecycle.status().mode !== 'running') throw new HttpError(503, 'Overseer is draining; retry later')
        const operation = await management.restartServer(identifier(query(params, 'server')))
        const location = `/operations/${operation.id}`
        send(202, { ...operation, statusUrl: location }, { Location: location })
      } else if (url.pathname.startsWith('/operations/')) {
        const operation = management.getOperation(url.pathname.slice('/operations/'.length))
        if (!operation) throw new HttpError(404, 'Operation not found')
        send(200, operation)
      } else {
        const name = identifier(query(params, 'server'))
        let metadata: [number, string, string] | undefined
        if (url.pathname === '/build/check') {
          metadata = [buildstamp(query(params, 'buildstamp')),
            identifier(query(params, 'byond'), 'byond version'),
            identifier(query(params, 'rustg'), 'rustg version')]
        }
        if (url.pathname === '/build/upload') releaseUpload = lifecycle.admit('uploads')
        if (!(await deployments.doesServerExist(name))) throw new HttpError(404, 'Server not found')
        if (metadata) {
          send(200, { outdated: await deployments.wantsNewArtifacts(name, ...metadata) })
        } else {
          await receiveUpload(req, res, config, deployments, name)
          send(200, { message: 'Success' })
        }
      }
    }
    handle().catch((error) => {
      const status = error instanceof HttpError ? error.statusCode : 500
      if (status >= 500) onError(error, { action: 'request', method: req.method })
      send(status, { message: error instanceof HttpError ? error.message : 'Internal server error' }, { Connection: 'close', ...(status === 503 ? { 'Retry-After': '5' } : {}) })
      req.resume()
    }).finally(() => releaseUpload?.())
  })
  server.requestTimeout = config.requestTimeoutMs
  server.headersTimeout = Math.min(config.requestTimeoutMs, 30000)
  server.keepAliveTimeout = 5000
  return server
}
