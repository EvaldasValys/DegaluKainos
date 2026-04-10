import type { RouteDetourResult, RouteDetourStation, RoutePoint, RouteResult } from '../../shared/types.js'
import { ROUTE_CACHE_TTL_MS, createRouteCacheKey, createViaRouteCacheKey } from '../../shared/cache.js'
import {
  readTimedJsonCacheValue,
  readTimedJsonCacheValues,
  writeTimedJsonCacheValue,
  writeTimedJsonCacheValues,
} from './cache-store.js'

const ROUTE_CACHE_FILE = 'route-cache.json'
const ROUTE_DETOUR_CACHE_FILE = 'route-detour-cache.json'
const ROUTE_DETOUR_BATCH_SIZE = 40

interface CachedViaRouteMetrics {
  totalRouteDistanceMeters: number
  totalRouteDurationSeconds: number
}

function serializePoint(point: RoutePoint) {
  return `${point.lng},${point.lat}`
}

async function requestRoute(points: RoutePoint[]) {
  const url = new URL(
    `https://router.project-osrm.org/route/v1/driving/${points.map(serializePoint).join(';')}`,
  )

  url.searchParams.set('overview', 'full')
  url.searchParams.set('geometries', 'geojson')

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'DegaluKainos/1.0 (+https://ena.lt)',
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`OSRM request failed with ${response.status}`)
  }

  const payload = (await response.json()) as {
    routes?: Array<{
      distance?: number
      duration?: number
      geometry?: {
        coordinates?: Array<[number, number]>
      }
    }>
  }
  const route = payload.routes?.[0]

  if (!route?.geometry?.coordinates || route.geometry.coordinates.length === 0) {
    throw new Error('No route was returned for the selected points')
  }

  return {
    distanceMeters: route.distance ?? 0,
    durationSeconds: route.duration ?? 0,
    geometry: route.geometry.coordinates,
  } satisfies RouteResult
}

async function requestTable(points: RoutePoint[]) {
  const url = new URL(
    `https://router.project-osrm.org/table/v1/driving/${points.map(serializePoint).join(';')}`,
  )

  url.searchParams.set('annotations', 'distance,duration')

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'DegaluKainos/1.0 (+https://ena.lt)',
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`OSRM table request failed with ${response.status}`)
  }

  const payload = (await response.json()) as {
    distances?: Array<Array<number | null>>
    durations?: Array<Array<number | null>>
  }

  return {
    distances: payload.distances ?? [],
    durations: payload.durations ?? [],
  }
}

export async function fetchRoute(
  start: RoutePoint,
  end: RoutePoint,
  via?: RoutePoint,
): Promise<RouteResult> {
  const cacheKey = via ? createViaRouteCacheKey(start, via, end) : createRouteCacheKey(start, end)
  const cachedRoute = await readTimedJsonCacheValue<RouteResult>(ROUTE_CACHE_FILE, cacheKey)

  if (cachedRoute) {
    return cachedRoute
  }

  const routeResult = await requestRoute(via ? [start, via, end] : [start, end])

  await writeTimedJsonCacheValue(ROUTE_CACHE_FILE, cacheKey, routeResult, ROUTE_CACHE_TTL_MS)

  return routeResult
}

export async function fetchRouteDetours(
  start: RoutePoint,
  end: RoutePoint,
  stations: RouteDetourStation[],
): Promise<RouteDetourResult[]> {
  if (stations.length === 0) {
    return []
  }

  const baseRoute = await fetchRoute(start, end)
  const cachedMetricsByStationId = new Map<string, CachedViaRouteMetrics>()
  const cacheKeyByStationId = new Map(
    stations.map((station) => [station.id, createViaRouteCacheKey(start, station.point, end)]),
  )
  const cachedMetricsByCacheKey = await readTimedJsonCacheValues<CachedViaRouteMetrics>(
    ROUTE_DETOUR_CACHE_FILE,
    Array.from(cacheKeyByStationId.values()),
  )
  const missingStations: RouteDetourStation[] = []

  for (const station of stations) {
    const cacheKey = cacheKeyByStationId.get(station.id)
    const cachedMetrics = cacheKey ? cachedMetricsByCacheKey.get(cacheKey) : undefined

    if (cachedMetrics) {
      cachedMetricsByStationId.set(station.id, cachedMetrics)
    } else {
      missingStations.push(station)
    }
  }

  for (let index = 0; index < missingStations.length; index += ROUTE_DETOUR_BATCH_SIZE) {
    const batch = missingStations.slice(index, index + ROUTE_DETOUR_BATCH_SIZE)
    const points = [start, end, ...batch.map((station) => station.point)]
    const table = await requestTable(points)
    const metricsToCache: Array<{ key: string; value: CachedViaRouteMetrics }> = []

    for (const [batchIndex, station] of batch.entries()) {
      const matrixIndex = batchIndex + 2
      const startToStationDistance = table.distances[0]?.[matrixIndex]
      const startToStationDuration = table.durations[0]?.[matrixIndex]
      const stationToEndDistance = table.distances[matrixIndex]?.[1]
      const stationToEndDuration = table.durations[matrixIndex]?.[1]

      if (
        startToStationDistance === null ||
        startToStationDistance === undefined ||
        startToStationDuration === null ||
        startToStationDuration === undefined ||
        stationToEndDistance === null ||
        stationToEndDistance === undefined ||
        stationToEndDuration === null ||
        stationToEndDuration === undefined
      ) {
        continue
      }

      const metrics = {
        totalRouteDistanceMeters: startToStationDistance + stationToEndDistance,
        totalRouteDurationSeconds: startToStationDuration + stationToEndDuration,
      } satisfies CachedViaRouteMetrics

      cachedMetricsByStationId.set(station.id, metrics)
      const cacheKey = cacheKeyByStationId.get(station.id)

      if (cacheKey) {
        metricsToCache.push({
          key: cacheKey,
          value: metrics,
        })
      }
    }

    if (metricsToCache.length > 0) {
      await writeTimedJsonCacheValues(ROUTE_DETOUR_CACHE_FILE, metricsToCache, ROUTE_CACHE_TTL_MS)
    }
  }

  return stations.flatMap((station) => {
    const metrics = cachedMetricsByStationId.get(station.id)

    if (!metrics) {
      return []
    }

    return [
      {
        stationId: station.id,
        detourDistanceMeters: Math.max(0, metrics.totalRouteDistanceMeters - baseRoute.distanceMeters),
        detourDurationSeconds: Math.max(
          0,
          metrics.totalRouteDurationSeconds - baseRoute.durationSeconds,
        ),
        totalRouteDistanceMeters: metrics.totalRouteDistanceMeters,
        totalRouteDurationSeconds: metrics.totalRouteDurationSeconds,
      } satisfies RouteDetourResult,
    ]
  })
}
