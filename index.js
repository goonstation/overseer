import http from 'http'
import util from 'node:util'
import child_process from 'node:child_process'
const exec = util.promisify(child_process.exec)

const host = process.env.SERVER_HOST ?? '0.0.0.0'
const port = process.env.SERVER_PORT ?? 8564
const containerPrefix = process.env.CONTAINER_PREFIX ?? 'ss13-'

const restarting = new Set()

function serverToContainer(server) {
  return `${containerPrefix}${server}`
}

async function getServers() {
  const { stdout: containers } = await exec(`docker container ls --format='{{.Names}}'`)
  return containers.trim().split('\n').filter((i) => i.startsWith(containerPrefix)).map((i) => i.replace(containerPrefix, ''))
}

async function getStateStatus(server) {
  const { stdout } = await exec(`docker inspect -f '{{.State.Status}}' ${serverToContainer(server)}`)
  return stdout.trim()
}

async function getStateHealth(server) {
  const { stdout } = await exec(`docker inspect -f '{{.State.Health.Status}}' ${serverToContainer(server)}`)
  return stdout.trim()
}

async function getStateStartedAt(server) {
  const { stdout } = await exec(`docker inspect -f '{{.State.StartedAt}}' ${serverToContainer(server)}`)
  return stdout.trim()
}

async function getServerStatus(server, servers = null) {
  if (!servers) {
    servers = await getServers()
    if (!servers.includes(server)) throw new Error('Server not found')
  }

  return {
    restarting: restarting.has(server),
    status: await getStateStatus(server),
    health: await getStateHealth(server),
    startedAt: await getStateStartedAt(server),
  }
}

async function getAllServersStatus() {
  const servers = await getServers()
  const ret = {}
  for (const server of servers) {
    ret[server] = await getServerStatus(server, servers)
  }
  return ret
}

async function restartServer(server) {
  if (restarting.has(server)) throw new Error('Already restarting')
  const servers = await getServers()
  if (!servers.includes(server)) throw new Error('Server not found')
  const health = await getStateHealth(server)
  if (health === 'starting') throw new Error('Currently starting')
  restarting.add(server)
  const container = serverToContainer(server)
  child_process.exec(`docker exec ${container} pkill -USR2 DreamDaemon && docker restart ${container}`, () => {
    restarting.delete(server)
  })
}

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

  res.statusCode = 404
  res.end()
})

server.listen(port, host, () => {
  console.log(`Server is running on http://${host}:${port}`)
})
