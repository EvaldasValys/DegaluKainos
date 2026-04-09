import type { AddressSuggestion, PriceSnapshot, RoutePoint, RouteResult } from '../../shared/types'
import {
  GEOCODE_CACHE_TTL_MS,
  LATEST_SNAPSHOT_CLIENT_CACHE_TTL_MS,
  NEGATIVE_LOOKUP_CACHE_TTL_MS,
  ROUTE_CACHE_TTL_MS,
  SUGGESTION_CACHE_TTL_MS,
  createAddressCacheKey,
  createRouteCacheKey,
  createSuggestionCacheKey,
} from '../../shared/cache'

const LOCAL_CACHE_PREFIX = 'degalukainos:api-cache:v1:'

interface LocalCacheEntry<T> {
  value: T
  cachedAt: number
  expiresAt: number
  etag?: string
  lastModified?: string
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error ?? 'Unexpected API error')
  }

  return (await response.json()) as T
}

function getLocalStorage() {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function getLocalCacheKey(key: string) {
  return `${LOCAL_CACHE_PREFIX}${key}`
}

function readLocalCacheEntry<T>(key: string): LocalCacheEntry<T> | null {
  const storage = getLocalStorage()

  if (!storage) {
    return null
  }

  try {
    const rawValue = storage.getItem(getLocalCacheKey(key))

    if (!rawValue) {
      return null
    }

    const parsed = JSON.parse(rawValue) as LocalCacheEntry<T>

    if (typeof parsed.expiresAt !== 'number' || typeof parsed.cachedAt !== 'number') {
      storage.removeItem(getLocalCacheKey(key))
      return null
    }

    return parsed
  } catch {
    storage.removeItem(getLocalCacheKey(key))
    return null
  }
}

function writeLocalCacheEntry<T>(key: string, entry: LocalCacheEntry<T>) {
  const storage = getLocalStorage()

  if (!storage) {
    return
  }

  storage.setItem(getLocalCacheKey(key), JSON.stringify(entry))
}

function createConditionalHeaders<T>(entry: LocalCacheEntry<T> | null) {
  const headers = new Headers()

  if (entry?.etag) {
    headers.set('If-None-Match', entry.etag)
  }

  if (entry?.lastModified) {
    headers.set('If-Modified-Since', entry.lastModified)
  }

  return headers
}

interface CachedJsonRequestOptions<T> {
  cacheKey: string
  ttlMs: number
  url: string
  getTtlMs?: (value: T) => number
  notFoundMessage?: string
  revalidateWithValidators?: boolean
}

async function fetchCachedJson<T>({
  cacheKey,
  ttlMs,
  url,
  getTtlMs,
  notFoundMessage,
  revalidateWithValidators = false,
}: CachedJsonRequestOptions<T>) {
  const cachedEntry = readLocalCacheEntry<T | null>(cacheKey)

  if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
    if (cachedEntry.value === null) {
      throw new Error(notFoundMessage ?? 'Requested resource was not found.')
    }

    return cachedEntry.value
  }

  try {
    const response = await fetch(url, {
      cache: revalidateWithValidators ? 'no-cache' : 'default',
      headers: revalidateWithValidators ? createConditionalHeaders(cachedEntry) : undefined,
    })

    if (response.status === 304 && cachedEntry && cachedEntry.value !== null) {
      writeLocalCacheEntry(cacheKey, {
        ...cachedEntry,
        expiresAt: Date.now() + ttlMs,
      })
      return cachedEntry.value
    }

    if (response.status === 404) {
      writeLocalCacheEntry(cacheKey, {
        value: null,
        cachedAt: Date.now(),
        expiresAt: Date.now() + NEGATIVE_LOOKUP_CACHE_TTL_MS,
      })
      throw new Error(notFoundMessage ?? 'Requested resource was not found.')
    }

    const payload = await readJson<T>(response)
    const nextTtlMs = getTtlMs ? getTtlMs(payload) : ttlMs

    writeLocalCacheEntry(cacheKey, {
      value: payload,
      cachedAt: Date.now(),
      expiresAt: Date.now() + nextTtlMs,
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
    })

    return payload
  } catch (error) {
    if (cachedEntry && cachedEntry.value !== null) {
      return cachedEntry.value
    }

    throw error
  }
}

export async function fetchLatestPrices() {
  return fetchCachedJson<PriceSnapshot>({
    cacheKey: 'latest-snapshot',
    ttlMs: LATEST_SNAPSHOT_CLIENT_CACHE_TTL_MS,
    url: '/api/prices/latest',
    revalidateWithValidators: true,
  })
}

export async function fetchRoute(start: RoutePoint, end: RoutePoint) {
  const params = new URLSearchParams({
    from: `${start.lat},${start.lng}`,
    to: `${end.lat},${end.lng}`,
  })

  return fetchCachedJson<RouteResult>({
    cacheKey: `route:${createRouteCacheKey(start, end)}`,
    ttlMs: ROUTE_CACHE_TTL_MS,
    url: `/api/route?${params.toString()}`,
  })
}

export async function fetchAddressPoint(address: string) {
  const params = new URLSearchParams({
    q: address,
  })

  return fetchCachedJson<RoutePoint>({
    cacheKey: `geocode:${createAddressCacheKey(address)}`,
    ttlMs: GEOCODE_CACHE_TTL_MS,
    url: `/api/geocode?${params.toString()}`,
    notFoundMessage: 'Address could not be geocoded.',
  })
}

export async function fetchAddressSuggestions(address: string) {
  const params = new URLSearchParams({
    q: address,
  })

  return fetchCachedJson<AddressSuggestion[]>({
    cacheKey: `suggest:${createSuggestionCacheKey(address, 5)}`,
    ttlMs: SUGGESTION_CACHE_TTL_MS,
    url: `/api/geocode/suggest?${params.toString()}`,
    getTtlMs: (suggestions) =>
      suggestions.length > 0 ? SUGGESTION_CACHE_TTL_MS : NEGATIVE_LOOKUP_CACHE_TTL_MS,
  })
}
