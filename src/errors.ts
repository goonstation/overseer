export class HttpError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

export function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' || typeof error.code === 'number' ? error.code : undefined
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

// Select diagnostic fields explicitly: command arguments, environment and stdout
// may contain credentials and must not be serialized wholesale.
export function errorLogDetails(error: unknown): Record<string, unknown> {
  const normalized = toError(error)
  const details: Record<string, unknown> = { message: normalized.message, stack: normalized.stack }
  const code = errorCode(error)
  if (code !== undefined) details.code = code
  if (typeof error === 'object' && error !== null) {
    if ('signal' in error && typeof error.signal === 'string') details.signal = error.signal
    if ('killed' in error && typeof error.killed === 'boolean') details.killed = error.killed
    if ('stderr' in error && typeof error.stderr === 'string') {
      details.stderr = error.stderr.slice(0, 4096)
      if (error.stderr.length > 4096) details.stderrTruncated = true
    }
  }
  return details
}
