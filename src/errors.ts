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
