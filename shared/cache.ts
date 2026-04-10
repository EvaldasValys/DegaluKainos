import type { RoutePoint } from './types.js'

export const ROUTE_CACHE_PRECISION = 4

export const ROUTE_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7
export const GEOCODE_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 90
export const SUGGESTION_CACHE_TTL_MS = 1000 * 60 * 60 * 24
export const NEGATIVE_LOOKUP_CACHE_TTL_MS = 1000 * 60 * 60
export const LATEST_SNAPSHOT_CLIENT_CACHE_TTL_MS = 1000 * 60 * 60 * 24

export const STATIC_ASSET_CACHE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

function normalizeCacheText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function roundCoordinate(value: number) {
  return Number(value.toFixed(ROUTE_CACHE_PRECISION))
}

export function createAddressCacheKey(address: string) {
  return normalizeCacheText(address)
}

export function createSuggestionCacheKey(address: string, limit: number) {
  return `${limit}:${normalizeCacheText(address)}`
}

export function createRouteCacheKey(start: RoutePoint, end: RoutePoint) {
  return createRoutePointsCacheKey([start, end])
}

export function createRoutePointsCacheKey(points: RoutePoint[]) {
  return [
    ...points.flatMap((point) => [roundCoordinate(point.lat), roundCoordinate(point.lng)]),
  ].join(',')
}

export function createPointCacheKey(point: RoutePoint) {
  return createRoutePointsCacheKey([point])
}

export function createViaRouteCacheKey(start: RoutePoint, via: RoutePoint, end: RoutePoint) {
  return createRoutePointsCacheKey([start, via, end])
}

export function getSuggestionCacheTtlMs(resultCount: number) {
  return resultCount > 0 ? SUGGESTION_CACHE_TTL_MS : NEGATIVE_LOOKUP_CACHE_TTL_MS
}
