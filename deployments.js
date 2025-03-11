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

function getFileTarget(name, server) {
  if (name === 'build') {
    return `${getServerPath(server)}/update`
  } else if (name === 'byond') {
    return byondRoot
  } else if (name === 'rustg') {
    return rustgRoot
  }
}

export async function onFileUpload(name, file, info, server) {
  const fileType = info.mimeType === 'application/zip' ? 'zip' : 'tar.gz'
  const fileName = `${name}-upload-${server}.${fileType}`
  const filePath = path.join(os.tmpdir(), fileName)
  await fs.writeFile(filePath, file)

  const fileTarget = getFileTarget(name, server)
  try {
    await fs.access(fileTarget)
  } catch {
    await fs.mkdir(fileTarget)
  }

  if (fileType === 'zip') {
    await exec(`unzip '${filePath}' -d '${fileTarget}'`)
  } else {
    await exec(`tar zxf '${filePath}' -C '${fileTarget}'`)
  }
  await exec(`chown -R ${gameUserOwner}:${gameUserGroup} '${fileTarget}'`)
  await exec(`chmod -R 770 '${fileTarget}'`)
}
