import { createFallbackService } from './fallbacks.js'
import { createLifecycle } from './lifecycle.js'
import './instrument.js'
import type { ErrorReporter } from './services.js'
import { errorLogDetails } from './errors.js'
import * as Sentry from '@sentry/node'
import { loadConfig } from './config.js'
import { createLocks } from './locks.js'
import { createApp } from './app.js'
import { createManagementService } from './management.js'
import { createDeploymentService } from './deployments.js'

const config = loadConfig()
const locks = createLocks()
const lifecycle = createLifecycle()
const onError: ErrorReporter = (error, context) => {
  console.error(JSON.stringify({ level: 'error', ...errorLogDetails(error), ...context }))
  Sentry.captureException(error, { extra: context })
}
const server = createApp(config, {
  lifecycle,
  management: createManagementService(config, { locks, onError, lifecycle }),
  deployments: createDeploymentService(config, { locks, onError }),
  fallbacks: createFallbackService(config, { locks, onError }),
  onError,
})
server.on('error', (error) => {
  onError(error, { action: 'listen' })
  process.exitCode = 1
})
server.listen(config.port, config.host, () => {
  console.log(`Server is running on http://${config.host}:${config.port}`)
})
let shuttingDown = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    lifecycle.stop()
    console.log(`Received ${signal}; draining requests and background work`)
    const timer = setTimeout(() => process.exit(1), Math.max(config.uploadTimeoutMs, config.restartTimeoutMs) + 5000)
    timer.unref()
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    void Promise.all([closed, lifecycle.waitForIdle()]).then(async () => {
      await Sentry.flush(2000)
      clearTimeout(timer)
    }).catch((error: unknown) => {
      onError(error, { action: 'shutdown' })
      process.exitCode = 1
    })
  })
}
