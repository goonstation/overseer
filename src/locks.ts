import { HttpError } from './errors.js'

export function createLocks() {
  const held = new Set<string>()
  return {
    acquire(keys: readonly string[]) {
      if (keys.some((key) => held.has(key))) throw new HttpError(409, 'Target is busy')
      for (const key of keys) held.add(key)
      let released = false
      return () => {
        if (released) return
        released = true
        for (const key of keys) held.delete(key)
      }
    },
    has(key: string) { return held.has(key) },
  }
}

export type Locks = ReturnType<typeof createLocks>
