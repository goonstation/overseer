import type { Config } from '../src/config.js'
import type { CommandRunner } from '../src/command.js'
import type { RestartOperation } from '../src/management.js'
import type { UploadSession } from '../src/deployments.js'

// Compile-only regressions: removing contract constraints makes @ts-expect-error fail.
function contracts(config: Config, run: CommandRunner, session: UploadSession, operation: RestartOperation) {
  // @ts-expect-error Configuration values are immutable.
  config.port = 9000
  // @ts-expect-error Commands take argument arrays rather than shell command strings.
  void run('docker', 'inspect alpha')
  // @ts-expect-error Uploads require a readable stream.
  void session.add('build', Buffer.from('archive'), { mimeType: 'application/zip' })
  if (operation.state === 'running') {
    const unfinished: null = operation.finishedAt
    void unfinished
    // @ts-expect-error Running operations have no completion timestamp.
    const completed: string = operation.finishedAt
    void completed
  }
  if (operation.state === 'failed') {
    const message: string = operation.error
    void message
    // @ts-expect-error Failed operations must retain a failure message.
    const absent: null = operation.error
    void absent
  }
}
void contracts
