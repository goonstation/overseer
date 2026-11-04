import type { Lifecycle } from './lifecycle.js'
import type { CommandRunner } from './command.js'
import type { Locks } from './locks.js'

export type ErrorReporter = (error: unknown, context: Record<string, unknown>) => void
export interface ServiceDependencies {
  lifecycle?: Lifecycle
  run?: CommandRunner
  locks?: Locks
  onError?: ErrorReporter
}
