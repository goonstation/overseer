import http from 'http'
import busboy from 'busboy'
import { getServerStatus, getAllServersStatus, restartServer } from './management.js'
import { wantsNewArtifacts, onBuildUpload, onByondUpload, onRustGUpload, doesServerExist } from './deployments.js'

const host = process.env.SERVER_HOST ?? '0.0.0.0'
const port = process.env.SERVER_PORT ?? 8564

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${host}`)
  const params = url.searchParams

  if (url.pathname === '/status') {
    try {
      let ret = {}
      if (params.has('server')) {
        ret[params.get('server')] = await getServerStatus(params.get('server'))
      } else {
        ret = await getAllServersStatus()
      }
      res.statusCode = 200
      res.end(JSON.stringify(ret))
    } catch (e) {
      res.statusCode = 500
      res.end(JSON.stringify({ message: e.message }))
    }
    return
  }

  if (url.pathname === '/restart' && params.has('server')) {
    try {
      await restartServer(params.get('server'))
      res.statusCode = 200
      res.end(JSON.stringify({ message: 'Success' }))
    } catch (e) {
      res.statusCode = 500
      res.end(JSON.stringify({ message: e.message }))
    }
    return
  }

  if (
    url.pathname === '/build/check' &&
    params.has('server') &&
    params.has('buildstamp') &&
    params.has('byond') &&
    params.has('rustg')
  ) {
    const server = params.get('server')
    const serverExists = await doesServerExist(server)
    if (!serverExists) {
      res.statusCode = 400
      res.end(JSON.stringify({ message: 'Server does not exist' }))
      return
    }
    const wants = await wantsNewArtifacts(
      server,
      parseInt(params.get('buildstamp')),
      params.get('byond'),
      params.get('rustg')
    )
    res.statusCode = 200
    res.end(JSON.stringify({ outdated: wants }))
    return
  }

  if (url.pathname === '/build/upload' && req.method === 'POST' && params.has('server')) {
    const server = params.get('server')
    const serverExists = await doesServerExist(server)
    if (!serverExists) {
      res.statusCode = 400
      res.end(JSON.stringify({ message: 'Server does not exist' }))
      return
    }

    const bb = busboy({ headers: req.headers })
    bb.on('file', (name, file, info) => {
      if (info.mimeType !== 'application/gzip') {
        file.resume()
        return
      }
      try {
        if (name === 'build') {
          onBuildUpload(file, server)
        } else if (name === 'byond') {
          onByondUpload(file, server)
        } else if (name === 'rustg') {
          onRustGUpload(file, server)
        } else {
          file.resume()
        }
      } catch (e) {
        console.error(e.message)
      }
    })
    bb.on('close', () => {
      res.statusCode = 200
      res.end(JSON.stringify({ message: 'Success' }))
    })
    req.pipe(bb)
    return
  }

  res.statusCode = 404
  res.end()
})

server.listen(port, host, () => {
  console.log(`Server is running on http://${host}:${port}`)
})
