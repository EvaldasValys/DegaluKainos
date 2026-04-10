import type { AddressSuggestion, RoutePoint } from '../../shared/types.js'
import {
  GEOCODE_CACHE_TTL_MS,
  NEGATIVE_LOOKUP_CACHE_TTL_MS,
  createAddressCacheKey,
  createPointCacheKey,
  createSuggestionCacheKey,
  getSuggestionCacheTtlMs,
} from '../../shared/cache.js'
import { readTimedJsonCacheValue, writeTimedJsonCacheValue } from './cache-store.js'

const GEOCODER_TIMEOUT_MS = 4000
const DEFAULT_SUGGESTION_LIMIT = 5
const LITHUANIA_COUNTRY_CODE = 'LT'
const GEOCODE_CACHE_FILE = 'address-geocode-cache.json'
const REVERSE_GEOCODE_CACHE_FILE = 'address-reverse-geocode-cache.json'
const SUGGESTION_CACHE_FILE = 'address-suggestion-cache.json'
const LITHUANIA_BBOX = {
  minLng: 20.93,
  minLat: 53.89,
  maxLng: 26.84,
  maxLat: 56.45,
}

interface PhotonFeature {
  geometry?: {
    coordinates?: [number, number]
  }
  properties?: {
    name?: string
    street?: string
    housenumber?: string
    postcode?: string
    city?: string
    town?: string
    village?: string
    county?: string
    state?: string
    country?: string
  }
}

interface NominatimReverseResponse {
  display_name?: string
  address?: {
    road?: string
    pedestrian?: string
    footway?: string
    path?: string
    cycleway?: string
    house_number?: string
    neighbourhood?: string
    suburb?: string
    city?: string
    town?: string
    village?: string
    municipality?: string
    county?: string
    state?: string
    country?: string
  }
}

function uniqueTextParts(parts: Array<string | undefined>) {
  const seen = new Set<string>()

  return parts.filter((part): part is string => {
    if (!part) {
      return false
    }

    const normalized = part.trim()

    if (!normalized) {
      return false
    }

    const key = normalized.toLowerCase()

    if (seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

function buildGeocodeQueries(address: string) {
  const trimmedAddress = address.trim()
  const withLithuania =
    /lithuania|lietuva/i.test(trimmedAddress) ? trimmedAddress : `${trimmedAddress}, Lietuva`

  return Array.from(new Set([trimmedAddress, withLithuania].filter(Boolean)))
}

function formatSuggestionLabel(feature: PhotonFeature) {
  const properties = feature.properties ?? {}
  const addressLine = [properties.street, properties.housenumber].filter(Boolean).join(' ').trim()
  const locality =
    properties.city ?? properties.town ?? properties.village ?? properties.county ?? properties.state
  const parts = uniqueTextParts([properties.name, addressLine, locality, properties.country])

  return parts.join(', ')
}

function toAddressSuggestion(feature: PhotonFeature): AddressSuggestion | null {
  const coordinates = feature.geometry?.coordinates

  if (!coordinates || coordinates.length < 2) {
    return null
  }

  return {
    label: formatSuggestionLabel(feature) || `${coordinates[1].toFixed(4)}, ${coordinates[0].toFixed(4)}`,
    point: {
      lat: coordinates[1],
      lng: coordinates[0],
    },
  }
}

async function fetchPhotonSuggestions(query: string, limit: number) {
  const url = new URL('https://photon.komoot.io/api/')
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('q', query)
  url.searchParams.set(
    'bbox',
    [
      LITHUANIA_BBOX.minLng,
      LITHUANIA_BBOX.minLat,
      LITHUANIA_BBOX.maxLng,
      LITHUANIA_BBOX.maxLat,
    ].join(','),
  )
  url.searchParams.set('countrycode', LITHUANIA_COUNTRY_CODE)

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'DegaluKainos/1.0 (+https://ena.lt)',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(GEOCODER_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`Photon geocoder responded with ${response.status}.`)
  }

  const payload = (await response.json()) as {
    features?: PhotonFeature[]
  }

  return (payload.features ?? [])
    .map(toAddressSuggestion)
    .filter((suggestion): suggestion is AddressSuggestion => suggestion !== null)
}

function formatReverseGeocodeLabel(payload: NominatimReverseResponse) {
  const address = payload.address ?? {}
  const streetName =
    address.road ?? address.pedestrian ?? address.footway ?? address.path ?? address.cycleway
  const addressLine = [streetName, address.house_number].filter(Boolean).join(' ').trim()
  const locality =
    address.city ?? address.town ?? address.village ?? address.municipality ?? address.county ?? address.state

  return (
    uniqueTextParts([addressLine || payload.display_name, address.neighbourhood, address.suburb, locality, address.country]).join(', ')
  )
}

async function fetchReverseGeocodedLabel(point: RoutePoint) {
  const url = new URL('https://nominatim.openstreetmap.org/reverse')
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('lat', String(point.lat))
  url.searchParams.set('lon', String(point.lng))
  url.searchParams.set('accept-language', 'lt')

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'DegaluKainos/1.0 (+https://ena.lt)',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(GEOCODER_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`Nominatim reverse geocoder responded with ${response.status}.`)
  }

  const payload = (await response.json()) as NominatimReverseResponse
  const label = formatReverseGeocodeLabel(payload)

  return label || null
}

async function fetchCachedSuggestions(query: string, limit: number) {
  const cacheKey = createSuggestionCacheKey(query, limit)
  const cachedSuggestions = await readTimedJsonCacheValue<AddressSuggestion[]>(
    SUGGESTION_CACHE_FILE,
    cacheKey,
  )

  if (cachedSuggestions !== undefined) {
    return cachedSuggestions
  }

  const suggestions = await fetchPhotonSuggestions(query, limit)

  await writeTimedJsonCacheValue(
    SUGGESTION_CACHE_FILE,
    cacheKey,
    suggestions,
    getSuggestionCacheTtlMs(suggestions.length),
  )

  return suggestions
}

export async function suggestAddresses(
  address: string,
  limit = DEFAULT_SUGGESTION_LIMIT,
): Promise<AddressSuggestion[]> {
  const queries = buildGeocodeQueries(address)
  const suggestions: AddressSuggestion[] = []
  const seen = new Set<string>()

  for (const query of queries) {
    try {
      const nextSuggestions = await fetchCachedSuggestions(query, limit)

      for (const suggestion of nextSuggestions) {
        const key = suggestion.label.toLowerCase()

        if (seen.has(key)) {
          continue
        }

        seen.add(key)
        suggestions.push(suggestion)

        if (suggestions.length >= limit) {
          return suggestions
        }
      }
    } catch {
      continue
    }
  }

  return suggestions
}

export async function geocodeAddress(address: string): Promise<RoutePoint | null> {
  const cacheKey = createAddressCacheKey(address)
  const cachedPoint = await readTimedJsonCacheValue<RoutePoint | null>(GEOCODE_CACHE_FILE, cacheKey)

  if (cachedPoint !== undefined) {
    return cachedPoint
  }

  const suggestion = (await suggestAddresses(address, 1))[0]
  const point = suggestion?.point ?? null

  await writeTimedJsonCacheValue(
    GEOCODE_CACHE_FILE,
    cacheKey,
    point,
    point ? GEOCODE_CACHE_TTL_MS : NEGATIVE_LOOKUP_CACHE_TTL_MS,
  )

  return point
}

export async function reverseGeocodePoint(point: RoutePoint): Promise<string | null> {
  const cacheKey = createPointCacheKey(point)
  const cachedLabel = await readTimedJsonCacheValue<string | null>(REVERSE_GEOCODE_CACHE_FILE, cacheKey)

  if (cachedLabel !== undefined) {
    return cachedLabel
  }

  const label = await fetchReverseGeocodedLabel(point)

  await writeTimedJsonCacheValue(
    REVERSE_GEOCODE_CACHE_FILE,
    cacheKey,
    label,
    label ? GEOCODE_CACHE_TTL_MS : NEGATIVE_LOOKUP_CACHE_TTL_MS,
  )

  return label
}
