import type { AddressSuggestion, PriceSnapshot, RoutePoint, RouteResult } from '../../shared/types'

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error ?? 'Unexpected API error')
  }

  return (await response.json()) as T
}

export async function fetchLatestPrices() {
  return readJson<PriceSnapshot>(await fetch('/api/prices/latest'))
}

export async function fetchRoute(start: RoutePoint, end: RoutePoint) {
  const params = new URLSearchParams({
    from: `${start.lat},${start.lng}`,
    to: `${end.lat},${end.lng}`,
  })

  return readJson<RouteResult>(await fetch(`/api/route?${params.toString()}`))
}

export async function fetchAddressPoint(address: string) {
  const params = new URLSearchParams({
    q: address,
  })

  return readJson<RoutePoint>(await fetch(`/api/geocode?${params.toString()}`))
}

export async function fetchAddressSuggestions(address: string) {
  const params = new URLSearchParams({
    q: address,
  })

  return readJson<AddressSuggestion[]>(await fetch(`/api/geocode/suggest?${params.toString()}`))
}
