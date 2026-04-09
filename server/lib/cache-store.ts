import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const cacheDir = path.join(process.cwd(), 'data', 'cache')
const memoryCache = new Map<string, unknown>()

interface ExpiringCacheEntry<T> {
  value: T
  updatedAt: string
  expiresAt: string
}

type ExpiringCacheRecord<T> = Record<string, ExpiringCacheEntry<T>>

async function ensureCacheDir() {
  await mkdir(cacheDir, { recursive: true })
}

export function getCachePath(fileName: string) {
  return path.join(cacheDir, fileName)
}

export async function readJsonCache<T>(fileName: string, fallback: T): Promise<T> {
  try {
    const contents = await readFile(getCachePath(fileName), 'utf-8')
    return JSON.parse(contents) as T
  } catch {
    return fallback
  }
}

export async function writeJsonCache(fileName: string, payload: unknown) {
  await ensureCacheDir()
  await writeFile(getCachePath(fileName), JSON.stringify(payload, null, 2), 'utf-8')
}

function isExpired(expiresAt: string) {
  return Date.parse(expiresAt) <= Date.now()
}

function pruneExpiredEntries<T>(payload: ExpiringCacheRecord<T>) {
  let wasPruned = false

  for (const [key, entry] of Object.entries(payload)) {
    if (isExpired(entry.expiresAt)) {
      delete payload[key]
      wasPruned = true
    }
  }

  return wasPruned
}

async function loadExpiringCache<T>(fileName: string) {
  const cachedPayload = memoryCache.get(fileName)

  if (cachedPayload) {
    return cachedPayload as ExpiringCacheRecord<T>
  }

  const payload = await readJsonCache<ExpiringCacheRecord<T>>(fileName, {})
  const wasPruned = pruneExpiredEntries(payload)

  memoryCache.set(fileName, payload)

  if (wasPruned) {
    await writeJsonCache(fileName, payload)
  }

  return payload
}

async function persistExpiringCache<T>(fileName: string, payload: ExpiringCacheRecord<T>) {
  memoryCache.set(fileName, payload)
  await writeJsonCache(fileName, payload)
}

export async function readTimedJsonCacheValue<T>(fileName: string, key: string) {
  const payload = await loadExpiringCache<T>(fileName)
  const entry = payload[key]

  if (!entry) {
    return undefined
  }

  if (isExpired(entry.expiresAt)) {
    delete payload[key]
    await persistExpiringCache(fileName, payload)
    return undefined
  }

  return entry.value
}

export async function writeTimedJsonCacheValue<T>(
  fileName: string,
  key: string,
  value: T,
  ttlMs: number,
) {
  const payload = await loadExpiringCache<T>(fileName)

  payload[key] = {
    value,
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  }

  await persistExpiringCache(fileName, payload)
}
