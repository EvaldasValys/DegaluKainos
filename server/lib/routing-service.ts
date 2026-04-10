import type { RouteDetourResult, RouteDetourStation, RoutePoint, RouteResult } from '../../shared/types.js'
import { ROUTE_CACHE_TTL_MS, ROUTE_CACHE_PRECISION, createRoutePointsCacheKey } from '../../shared/cache.js'
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
  insertAfterIndex: number
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

export async function fetchRoute(points: RoutePoint[]): Promise<RouteResult> {
  const cacheKey = createRoutePointsCacheKey(points)
  const cachedRoute = await readTimedJsonCacheValue<RouteResult>(ROUTE_CACHE_FILE, cacheKey)

  if (cachedRoute) {
    return cachedRoute
  }

  const routeResult = await requestRoute(points)

  await writeTimedJsonCacheValue(ROUTE_CACHE_FILE, cacheKey, routeResult, ROUTE_CACHE_TTL_MS)

  return routeResult
}

export async function fetchRouteDetours(
  points: RoutePoint[],
  stations: RouteDetourStation[],
): Promise<RouteDetourResult[]> {
  if (stations.length === 0 || points.length < 2) {
    return []
  }

  const baseRoute = await fetchRoute(points)
  const baseTable = await requestTable(points)
  const baseRouteDistanceMeters =
    sumAdjacentValues(baseTable.distances, points.length) ?? baseRoute.distanceMeters
  const baseRouteDurationSeconds =
    sumAdjacentValues(baseTable.durations, points.length) ?? baseRoute.durationSeconds
  const cachedMetricsByStationId = new Map<string, CachedViaRouteMetrics>()
  const cacheKeyByStationId = new Map(
    stations.map((station) => [station.id, createDetourCacheKey(points, station.point)]),
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
    const tablePoints = [...points, ...batch.map((station) => station.point)]
    const table = await requestTable(tablePoints)
    const metricsToCache: Array<{ key: string; value: CachedViaRouteMetrics }> = []

    for (const [batchIndex, station] of batch.entries()) {
      const matrixIndex = batchIndex + points.length
      let bestMetrics: CachedViaRouteMetrics | null = null

      for (let segmentIndex = 0; segmentIndex < points.length - 1; segmentIndex += 1) {
        const segmentDistance = table.distances[segmentIndex]?.[segmentIndex + 1]
        const segmentDuration = table.durations[segmentIndex]?.[segmentIndex + 1]
        const startToStationDistance = table.distances[segmentIndex]?.[matrixIndex]
        const startToStationDuration = table.durations[segmentIndex]?.[matrixIndex]
        const stationToEndDistance = table.distances[matrixIndex]?.[segmentIndex + 1]
        const stationToEndDuration = table.durations[matrixIndex]?.[segmentIndex + 1]

        if (
          segmentDistance === null ||
          segmentDistance === undefined ||
          segmentDuration === null ||
          segmentDuration === undefined ||
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

        const totalRouteDistanceMeters =
          baseRouteDistanceMeters - segmentDistance + startToStationDistance + stationToEndDistance
        const totalRouteDurationSeconds =
          baseRouteDurationSeconds - segmentDuration + startToStationDuration + stationToEndDuration

        if (
          !bestMetrics ||
          totalRouteDistanceMeters < bestMetrics.totalRouteDistanceMeters ||
          (totalRouteDistanceMeters === bestMetrics.totalRouteDistanceMeters &&
            totalRouteDurationSeconds < bestMetrics.totalRouteDurationSeconds)
        ) {
          bestMetrics = {
            totalRouteDistanceMeters,
            totalRouteDurationSeconds,
            insertAfterIndex: segmentIndex,
          }
        }
      }

      if (!bestMetrics) {
        continue
      }

      cachedMetricsByStationId.set(station.id, bestMetrics)
      const cacheKey = cacheKeyByStationId.get(station.id)

      if (cacheKey) {
        metricsToCache.push({
          key: cacheKey,
          value: bestMetrics,
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
        detourDistanceMeters: Math.max(0, metrics.totalRouteDistanceMeters - baseRouteDistanceMeters),
        detourDurationSeconds: Math.max(
          0,
          metrics.totalRouteDurationSeconds - baseRouteDurationSeconds,
        ),
        totalRouteDistanceMeters: metrics.totalRouteDistanceMeters,
        totalRouteDurationSeconds: metrics.totalRouteDurationSeconds,
        insertAfterIndex: metrics.insertAfterIndex,
      } satisfies RouteDetourResult,
    ]
  })
}
function createDetourCacheKey(points: RoutePoint[], station: RoutePoint) {
  return `${createRoutePointsCacheKey(points)}::${station.lat.toFixed(ROUTE_CACHE_PRECISION)},${station.lng.toFixed(ROUTE_CACHE_PRECISION)}`
}

function sumAdjacentValues(matrix: Array<Array<number | null>>, pointCount: number) {
  let total = 0

  for (let index = 0; index < pointCount - 1; index += 1) {
    const value = matrix[index]?.[index + 1]

    if (value === null || value === undefined) {
      return null
    }

    total += value
  }

  return total
}
