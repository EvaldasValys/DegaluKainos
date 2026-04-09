import type { PriceSnapshot, RoutePoint, RouteResult } from '../../shared/types'

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error ?? 'Unexpected API error')
  }

  return (await response.json()) as T
}

export async function fetchTodayPrices() {
  return readJson<PriceSnapshot>(await fetch('/api/prices/today'))
}

export async function fetchRoute(start: RoutePoint, end: RoutePoint) {
  const params = new URLSearchParams({
    from: `${start.lat},${start.lng}`,
    to: `${end.lat},${end.lng}`,
  })

  return readJson<RouteResult>(await fetch(`/api/route?${params.toString()}`))
}
