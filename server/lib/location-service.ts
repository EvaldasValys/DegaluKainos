import type { SnapshotCoverage, StationRecord } from '../../shared/types.js'
import { readJsonCache, writeJsonCache } from './cache-store.js'
import { geocodeAddress } from './geocoding-service.js'
import {
  municipalityToCity,
  normalizeStreet,
  normalizeText,
  parseStationAddress,
  sleep,
} from './utils.js'

interface LocationCacheEntry {
  lat: number
  lng: number
  source: 'osm' | 'geocode'
  updatedAt: string
}

type LocationCache = Record<string, LocationCacheEntry>

interface OsmFuelStation {
  id: string
  lat: number
  lng: number
  brand: string
  name: string
  street: string
  streetKey: string
  houseNumber: string
  houseNumberKey: string
  city: string
  cityKey: string
  networkKey: string
}

interface OsmCachePayload {
  fetchedAt: string
  stations: OsmFuelStation[]
}

interface OverpassElement {
  id: number
  lat?: number
  lon?: number
  center?: {
    lat: number
    lon: number
  }
  tags?: Record<string, string>
}

const LOCATION_CACHE_FILE = 'station-location-cache.json'
const OSM_CACHE_FILE = 'osm-fuel-stations.json'
const OSM_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7
const MAX_GEOCODER_LOOKUPS = 40
const GEOCODER_CONCURRENCY = 4
const GEOCODER_DELAY_MS = 150

function createCoverage(stations: StationRecord[]): SnapshotCoverage {
  const locatedStations = stations.filter((station) => station.coordinates !== null)
  const cacheMatches = locatedStations.filter((station) => station.coordinates?.source === 'cache').length
  const osmMatches = locatedStations.filter((station) => station.coordinates?.source === 'osm').length
  const geocoderMatches = locatedStations.filter(
    (station) => station.coordinates?.source === 'geocode',
  ).length

  return {
    totalStations: stations.length,
    locatedStations: locatedStations.length,
    missingStations: stations.length - locatedStations.length,
    cacheMatches,
    osmMatches,
    geocoderMatches,
  }
}

async function loadOsmStations() {
  const cached = await readJsonCache<OsmCachePayload | null>(OSM_CACHE_FILE, null)
  const now = Date.now()

  if (cached && now - Date.parse(cached.fetchedAt) < OSM_CACHE_TTL_MS) {
    return cached.stations
  }

  const query = `
[out:json][timeout:60];
area["ISO3166-1"="LT"][admin_level=2]->.lt;
(
  node["amenity"="fuel"](area.lt);
  way["amenity"="fuel"](area.lt);
  relation["amenity"="fuel"](area.lt);
);
out center tags;
`

  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'DegaluKainos/1.0 (+https://ena.lt)',
    },
    body: new URLSearchParams({ data: query }),
  })

  if (!response.ok) {
    throw new Error(`Overpass query failed with ${response.status}`)
  }

  const payload = (await response.json()) as { elements?: OverpassElement[] }
  const stations = (payload.elements ?? [])
    .map((element) => {
      const lat = element.lat ?? element.center?.lat
      const lng = element.lon ?? element.center?.lon
      const tags = element.tags ?? {}

      if (lat === undefined || lng === undefined) {
        return null
      }

      const brand = tags.brand ?? tags.operator ?? ''
      const name = tags.name ?? ''
      const street = tags['addr:street'] ?? tags['addr:place'] ?? ''
      const houseNumber = tags['addr:housenumber'] ?? ''
      const city = tags['addr:city'] ?? tags['addr:town'] ?? tags['addr:village'] ?? ''

      return {
        id: String(element.id),
        lat,
        lng,
        brand,
        name,
        street,
        streetKey: normalizeStreet(street),
        houseNumber,
        houseNumberKey: normalizeText(houseNumber),
        city,
        cityKey: normalizeText(city),
        networkKey: normalizeText([brand, name].filter(Boolean).join(' ')),
      } satisfies OsmFuelStation
    })
    .filter((station): station is OsmFuelStation => station !== null)

  await writeJsonCache(OSM_CACHE_FILE, {
    fetchedAt: new Date().toISOString(),
    stations,
  } satisfies OsmCachePayload)

  return stations
}

function scoreCandidate(station: StationRecord, candidate: OsmFuelStation) {
  const parsedAddress = parseStationAddress(station.address, station.municipality)
  const municipalityKey = normalizeText(municipalityToCity(station.municipality))
  const stationNetwork = normalizeText(station.network)

  let score = 0

  if (parsedAddress.cityKey && candidate.cityKey) {
    if (parsedAddress.cityKey === candidate.cityKey) {
      score += 30
    } else if (
      parsedAddress.cityKey.includes(candidate.cityKey) ||
      candidate.cityKey.includes(parsedAddress.cityKey)
    ) {
      score += 18
    }
  } else if (municipalityKey && candidate.cityKey && municipalityKey.includes(candidate.cityKey)) {
    score += 8
  }

  if (parsedAddress.streetKey && candidate.streetKey) {
    if (parsedAddress.streetKey === candidate.streetKey) {
      score += 34
    } else if (
      parsedAddress.streetKey.includes(candidate.streetKey) ||
      candidate.streetKey.includes(parsedAddress.streetKey)
    ) {
      score += 18
    }
  }

  if (parsedAddress.houseNumberKey && candidate.houseNumberKey) {
    if (parsedAddress.houseNumberKey === candidate.houseNumberKey) {
      score += 28
    } else if (
      parsedAddress.houseNumberKey.startsWith(candidate.houseNumberKey) ||
      candidate.houseNumberKey.startsWith(parsedAddress.houseNumberKey)
    ) {
      score += 12
    }
  }

  if (stationNetwork && candidate.networkKey) {
    if (stationNetwork === candidate.networkKey) {
      score += 18
    } else if (
      stationNetwork.includes(candidate.networkKey) ||
      candidate.networkKey.includes(stationNetwork)
    ) {
      score += 10
    }
  }

  if (candidate.streetKey === '') {
    score -= 10
  }

  return score
}

function findBestOsmCandidate(station: StationRecord, candidates: OsmFuelStation[]) {
  let bestCandidate: OsmFuelStation | null = null
  let bestScore = 0

  for (const candidate of candidates) {
    const score = scoreCandidate(station, candidate)

    if (score > bestScore) {
      bestScore = score
      bestCandidate = candidate
    }
  }

  return bestScore >= 62 ? bestCandidate : null
}

async function geocodeStation(station: StationRecord) {
  const address = parseStationAddress(station.address, station.municipality)
  const queries = [
    [station.network, address.rawAddress, station.municipality, 'Lithuania'],
    [
      [address.street, address.houseNumber].filter(Boolean).join(' '),
      address.city || station.city,
      station.municipality,
      'Lithuania',
    ],
    [station.address, station.municipality, 'Lithuania'],
  ]
    .map((parts) => parts.filter(Boolean).join(', '))
    .filter((query, index, values) => query.length > 0 && values.indexOf(query) === index)

  for (const query of queries) {
    const geocodedPoint = await geocodeAddress(query)

    if (geocodedPoint) {
      return geocodedPoint
    }
  }

  return null
}

export async function resolveStationLocations(stations: StationRecord[]) {
  const locationCache = await readJsonCache<LocationCache>(LOCATION_CACHE_FILE, {})
  const locationNotes: string[] = []
  let osmStations: OsmFuelStation[] = []
  let cacheWasUpdated = false

  try {
    osmStations = await loadOsmStations()
  } catch (error) {
    locationNotes.push(
      `OpenStreetMap fuel station cache could not be refreshed: ${
        error instanceof Error ? error.message : 'unknown error'
      }. Falling back to the local location cache and limited geocoding.`,
    )
  }

  for (const station of stations) {
    const cachedLocation = locationCache[station.id]

    if (cachedLocation) {
      station.coordinates = {
        lat: cachedLocation.lat,
        lng: cachedLocation.lng,
        source: 'cache',
      }
      continue
    }

    if (osmStations.length === 0) {
      continue
    }

    const candidate = findBestOsmCandidate(station, osmStations)

    if (!candidate) {
      continue
    }

    station.coordinates = {
      lat: candidate.lat,
      lng: candidate.lng,
      source: 'osm',
    }

    locationCache[station.id] = {
      lat: candidate.lat,
      lng: candidate.lng,
      source: 'osm',
      updatedAt: new Date().toISOString(),
    }
    cacheWasUpdated = true
  }

  const missingStations = stations.filter((station) => station.coordinates === null)
  const geocoderBatch = missingStations.slice(0, MAX_GEOCODER_LOOKUPS)

  for (let chunkIndex = 0; chunkIndex < geocoderBatch.length; chunkIndex += GEOCODER_CONCURRENCY) {
    if (chunkIndex > 0) {
      await sleep(GEOCODER_DELAY_MS)
    }

    const chunk = geocoderBatch.slice(chunkIndex, chunkIndex + GEOCODER_CONCURRENCY)
    const resolvedChunk = await Promise.all(
      chunk.map(async (station) => ({
        station,
        geocoded: await geocodeStation(station),
      })),
    )

    for (const { station, geocoded } of resolvedChunk) {
      if (!geocoded) {
        continue
      }

      station.coordinates = {
        lat: geocoded.lat,
        lng: geocoded.lng,
        source: 'geocode',
      }
      locationCache[station.id] = {
        lat: geocoded.lat,
        lng: geocoded.lng,
        source: 'geocode',
        updatedAt: new Date().toISOString(),
      }
      cacheWasUpdated = true
    }
  }

  if (cacheWasUpdated) {
    await writeJsonCache(LOCATION_CACHE_FILE, locationCache)
  }

  const coverage = createCoverage(stations)

  if (coverage.missingStations > 0) {
    locationNotes.push(
      `${coverage.missingStations} station(s) still do not have coordinates. The route map only uses stations with known locations.`,
    )
  }

  return {
    stations,
    coverage,
    locationNotes,
  }
}
