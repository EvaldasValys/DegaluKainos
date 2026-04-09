export const FUEL_KEYS = ['gasoline95', 'diesel', 'lpg'] as const

export type FuelKey = (typeof FUEL_KEYS)[number]

export const FUEL_LABELS: Record<FuelKey, string> = {
  gasoline95: '95 benzinas',
  diesel: 'Dyzelinas',
  lpg: 'SND',
}

export type CoordinateSource = 'cache' | 'osm' | 'geocode'

export interface FuelPrices {
  gasoline95: number | null
  diesel: number | null
  lpg: number | null
}

export interface StationCoordinates {
  lat: number
  lng: number
  source: CoordinateSource
}

export interface StationRecord {
  id: string
  reportedDate: string
  network: string
  municipality: string
  city: string
  address: string
  searchableText: string
  prices: FuelPrices
  coordinates: StationCoordinates | null
}

export interface SnapshotCoverage {
  totalStations: number
  locatedStations: number
  missingStations: number
  cacheMatches: number
  osmMatches: number
  geocoderMatches: number
}

export interface PriceSnapshot {
  fetchedAt: string
  snapshotDate: string
  sourceUrl: string
  stations: StationRecord[]
  coverage: SnapshotCoverage
  locationNotes: string[]
}

export interface RoutePoint {
  lat: number
  lng: number
}

export interface AddressSuggestion {
  label: string
  point: RoutePoint
}

export interface RouteResult {
  distanceMeters: number
  durationSeconds: number
  geometry: Array<[number, number]>
}
