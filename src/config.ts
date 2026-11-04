import path from 'node:path'

export type Environment = Record<string, string | undefined>

function integer(env: Environment, key: string, fallback: number, max = Number.MAX_SAFE_INTEGER, min = 1) {
  const raw = env[key] ?? String(fallback)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`)
  }
  return Number(raw)
}

export function loadConfig(env: Environment = process.env) {
  if (!env.API_TOKEN || env.API_TOKEN.length < 32 || /\s/.test(env.API_TOKEN)) {
    throw new Error('API_TOKEN must contain at least 32 characters without whitespace')
  }
  const maxUploadBytes = integer(env, 'MAX_UPLOAD_BYTES', 512 * 1024 * 1024)
  const uploadTimeoutMs = integer(env, 'UPLOAD_TIMEOUT_MS', 300000, 2147483647)
  const config = {
    apiToken: env.API_TOKEN,
    host: env.SERVER_HOST ?? '127.0.0.1',
    port: integer(env, 'SERVER_PORT', 8564, 65535),
    serversRoot: path.resolve(env.SERVERS_ROOT ?? '/servers'),
    byondRoot: path.resolve(env.BYOND_ROOT ?? '/byond'),
    rustgRoot: path.resolve(env.RUSTG_ROOT ?? '/rust-g'),
    containerPrefix: env.CONTAINER_PREFIX ?? 'ss13-',
    gameUserOwner: integer(env, 'GAME_USER_OWNER', 306969, 4294967294, 0),
    gameUserGroup: integer(env, 'GAME_USER_GROUP', 306969, 4294967294, 0),
    maxUploadBytes,
    maxRequestBytes: integer(env, 'MAX_REQUEST_BYTES', maxUploadBytes * 3 + 65536),
    maxExtractedBytes: integer(env, 'MAX_EXTRACTED_BYTES', 2 * 1024 * 1024 * 1024),
    maxArchiveEntries: integer(env, 'MAX_ARCHIVE_ENTRIES', 100000),
    uploadTimeoutMs,
    requestTimeoutMs: integer(env, 'REQUEST_TIMEOUT_MS', uploadTimeoutMs + 30000, 2147483647),
    commandTimeoutMs: integer(env, 'COMMAND_TIMEOUT_MS', 120000, 2147483647),
    restartTimeoutMs: integer(env, 'RESTART_TIMEOUT_MS', 300000, 2147483647),
    operationLimit: integer(env, 'OPERATION_LIMIT', 1000),
    operationTtlMs: integer(env, 'OPERATION_TTL_MS', 24 * 60 * 60 * 1000),
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(config.containerPrefix)) {
    throw new Error('CONTAINER_PREFIX must be a nonempty Docker name prefix')
  }
  if (config.requestTimeoutMs <= config.uploadTimeoutMs) {
    throw new Error('REQUEST_TIMEOUT_MS must be greater than UPLOAD_TIMEOUT_MS')
  }
  return Object.freeze(config)
}

export type Config = ReturnType<typeof loadConfig>
