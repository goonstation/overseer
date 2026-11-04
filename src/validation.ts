import fs from 'node:fs/promises'
import path from 'node:path'
import { HttpError, errorCode } from './errors.js'

export function identifier(value: unknown, label = 'server'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new HttpError(400, `Invalid ${label}`)
  }
  return value
}

export function buildstamp(value: unknown): number {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new HttpError(400, 'Invalid buildstamp')
  }
  return Number(value)
}

// Configured roots may themselves be symlinks. Request-selected descendants may not.
export async function managedPath(root: string, ...segments: string[]): Promise<string> {
  const base = await fs.realpath(root)
  let target = base
  for (const segment of segments) {
    if (typeof segment !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(segment) || ['.', '..'].includes(segment)) {
      throw new HttpError(400, 'Invalid path component')
    }
    target = path.join(target, segment)
    try {
      const stat = await fs.lstat(target)
      if (stat.isSymbolicLink()) throw new HttpError(400, 'Symlinks are not allowed in managed paths')
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }
  return target
}
