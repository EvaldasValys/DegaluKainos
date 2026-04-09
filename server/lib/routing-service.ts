import type { RoutePoint, RouteResult } from '../../shared/types.js'

function serializePoint(point: RoutePoint) {
  return `${point.lng},${point.lat}`
}

export async function fetchRoute(start: RoutePoint, end: RoutePoint): Promise<RouteResult> {
  const url = new URL(
    `https://router.project-osrm.org/route/v1/driving/${serializePoint(start)};${serializePoint(end)}`,
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
  }
}
