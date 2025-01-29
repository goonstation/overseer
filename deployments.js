import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import util from 'node:util'
import child_process from 'node:child_process'
const exec = util.promisify(child_process.exec)

const serversRoot = process.env.SERVERS_ROOT ?? '/servers'
const byondRoot = process.env.BYOND_ROOT ?? '/byond'
const rustgRoot = process.env.RUSTG_ROOT ?? '/rust-g'
const gameUserOwner = process.env.GAME_USER_OWNER ?? '306969'
const gameUserGroup = process.env.GAME_USER_GROUP ?? '306969'

function getServerPath(server) {
  return `${serversRoot}/${server}/game`
}

export async function doesServerExist(server) {
  try {
    await fs.access(getServerPath(server))
    return true
  } catch {
    return false
  }
}

async function getBuildEnv(server, update = false) {
  let path = getServerPath(server)
  if (update) path += '/update'
  const file = await fs.readFile(`${path}/.env.build`, { encoding: 'utf8' })
  const buildEnv = {}
  for (const line of file.split('\n')) {
    const [key, value] = line.split('=')
    buildEnv[key.toLowerCase()] = value
  }
  return buildEnv
}

async function getBuildStamp(server, update = false) {
  try {
    const buildEnv = await getBuildEnv(server, update)
    return parseInt(buildEnv?.buildstamp) || 0
  } catch {
    return 0
  }
}

export async function wantsNewArtifacts(server, newBuildStamp, newByond, newRustG) {
  const wants = { game: false, byond: false, rustg: false }

  const currentBuildStamp = await getBuildStamp(server)
  const updateBuildStamp = await getBuildStamp(server, true)
  if (updateBuildStamp) wants.game = newBuildStamp > updateBuildStamp
  else wants.game = newBuildStamp > currentBuildStamp

  try {
    await fs.access(`${byondRoot}/${newByond}`)
  } catch {
    wants.byond = true
  }

  try {
    await fs.access(`${rustgRoot}/${newRustG}`)
  } catch {
    wants.rustg = true
  }

  return wants
}

export async function onBuildUpload(file, server) {
  const fileName = `build-upload-${server}.tar.gz`
  const filePath = path.join(os.tmpdir(), fileName)
  await fs.writeFile(filePath, file)

  const updatePath = `${getServerPath(server)}/update`
  try {
    await fs.access(updatePath)
  } catch {
    await fs.mkdir(updatePath)
  }

  await exec(`tar zxf '${filePath}' -C '${updatePath}'`)
  await exec(`chown -R ${gameUserOwner}:${gameUserGroup} '${updatePath}'`)
  await exec(`chmod -R 770 '${updatePath}'`)
}

export async function onByondUpload(file, server) {
  const fileName = `byond-upload-${server}.tar.gz`
  const filePath = path.join(os.tmpdir(), fileName)
  await fs.writeFile(filePath, file)

  try {
    await fs.access(byondRoot)
  } catch {
    await fs.mkdir(byondRoot)
  }

  await exec(`tar zxf '${filePath}' -C '${byondRoot}'`)
  await exec(`chown -R ${gameUserOwner}:${gameUserGroup} '${byondRoot}'`)
  await exec(`chmod -R 770 '${byondRoot}'`)
}

export async function onRustGUpload(file, server) {
  const fileName = `rustg-upload-${server}.tar.gz`
  const filePath = path.join(os.tmpdir(), fileName)
  await fs.writeFile(filePath, file)

  try {
    await fs.access(rustgRoot)
  } catch {
    await fs.mkdir(rustgRoot)
  }

  await exec(`tar zxf '${filePath}' -C '${rustgRoot}'`)
  await exec(`chown -R ${gameUserOwner}:${gameUserGroup} '${rustgRoot}'`)
  await exec(`chmod -R 770 '${rustgRoot}'`)
}
