import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { lineString, point } from '@turf/helpers'
import pointToLineDistance from '@turf/point-to-line-distance'
import {
  type AddressSuggestion,
  FUEL_KEYS,
  FUEL_LABELS,
  type FuelKey,
  type PriceSnapshot,
  type RouteDetourResult,
  type RouteDetourStation,
  type RoutePoint,
  type RouteResult,
  type StationRecord,
} from '../shared/types'
import { RouteMap } from './components/RouteMap'
import {
  fetchAddressPoint,
  fetchAddressSuggestions,
  fetchLatestPricesWithOptions,
  fetchRouteDetours,
  fetchRoute,
} from './lib/api'
import './App.css'

type ListVisibility = 'all' | 'priced' | 'mapped' | 'route'
type PointInputMode = 'map' | 'address'
type AddressFieldKey = 'start' | 'end'

const AUTOCOMPLETE_MIN_QUERY_LENGTH = 3
const AUTOCOMPLETE_DEBOUNCE_MS = 250
const SNAPSHOT_REFRESH_DEBOUNCE_MS = 5000
const DEFAULT_CORRIDOR_KM = 2.5
const NEARBY_CONTEXT_RADIUS_KM = 5
const MAX_CORRIDOR_KM = 10
const ROUTE_DETOUR_CHUNK_SIZE = 50
const DEFAULT_BLACKLIST = ['Jozita']
const DEFAULT_PLANNED_FUEL_LITERS = 40
const DEFAULT_FUEL_CONSUMPTION_PER_100_KM = 7
const DEFAULT_DISCOVERY_RESULTS_LIMIT = 12

interface RouteCandidate {
  station: StationRecord
  detourDistanceKm: number
  detourDurationSeconds: number
  fuelPrice: number | null
  purchaseLiters: number
  purchaseCost: number | null
  detourFuelLiters: number
  detourFuelCost: number | null
  totalEstimatedCost: number | null
}

interface MapFocusTarget {
  stationId: string
  requestId: number
}

interface AddressAutocompleteFieldProps {
  label: string
  value: string
  placeholder: string
  isActive: boolean
  isLoading: boolean
  suggestions: AddressSuggestion[]
  onChange: (value: string) => void
  onFocus: () => void
  onBlur: () => void
  onSelectSuggestion: (suggestion: AddressSuggestion) => void
}

const fuelPriceFormatter = new Intl.NumberFormat('lt-LT', {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
})

const moneyFormatter = new Intl.NumberFormat('lt-LT', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const quantityFormatter = new Intl.NumberFormat('lt-LT', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

const coordinateFormatter = new Intl.NumberFormat('lt-LT', {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
})

const dateTimeFormatter = new Intl.DateTimeFormat('lt-LT', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatFuelPrice(value: number | null) {
  return value === null ? 'N/A' : `${fuelPriceFormatter.format(value)} EUR`
}

function formatMoney(value: number | null) {
  return value === null ? 'N/A' : `${moneyFormatter.format(value)} EUR`
}

function formatDuration(durationSeconds: number) {
  const totalMinutes = Math.round(durationSeconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours === 0) {
    return `${minutes} min`
  }

  return `${hours} val. ${minutes} min`
}

function formatDistance(distanceMeters: number) {
  return `${(distanceMeters / 1000).toFixed(1)} km`
}

function formatPoint(pointValue: RoutePoint | null, emptyLabel = 'Pasirinkite žemėlapyje') {
  if (!pointValue) {
    return emptyLabel
  }

  return `${coordinateFormatter.format(pointValue.lat)}, ${coordinateFormatter.format(pointValue.lng)}`
}

function formatKilometers(distanceKm: number) {
  return `${quantityFormatter.format(distanceKm)} km`
}

function formatDateTime(value: string) {
  const parsedDate = new Date(value)

  if (Number.isNaN(parsedDate.getTime())) {
    return value
  }

  return dateTimeFormatter.format(parsedDate)
}

function parseNumberInputValue(value: string) {
  const normalizedValue = value.trim().replace(',', '.')

  if (!normalizedValue) {
    return null
  }

  const parsedValue = Number(normalizedValue)

  return Number.isFinite(parsedValue) ? parsedValue : null
}

function normalizeNetworkName(value: string) {
  return value.trim().toLowerCase()
}

function calculateDistanceBetweenPointsKm(start: RoutePoint, end: RoutePoint) {
  const earthRadiusKm = 6371
  const latDistance = ((end.lat - start.lat) * Math.PI) / 180
  const lngDistance = ((end.lng - start.lng) * Math.PI) / 180
  const startLatRadians = (start.lat * Math.PI) / 180
  const endLatRadians = (end.lat * Math.PI) / 180
  const haversineDistance =
    Math.sin(latDistance / 2) * Math.sin(latDistance / 2) +
    Math.cos(startLatRadians) *
      Math.cos(endLatRadians) *
      Math.sin(lngDistance / 2) *
      Math.sin(lngDistance / 2)

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(haversineDistance), Math.sqrt(1 - haversineDistance))
}

function addBlacklistedNetwork(existingNetworks: string[], value: string) {
  const trimmedValue = value.trim()

  if (!trimmedValue) {
    return existingNetworks
  }

  const normalizedValue = normalizeNetworkName(trimmedValue)

  if (existingNetworks.some((network) => normalizeNetworkName(network) === normalizedValue)) {
    return existingNetworks
  }

  return [...existingNetworks, trimmedValue].sort((left, right) => left.localeCompare(right, 'lt'))
}

function useAddressSuggestions(query: string, enabled: boolean) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([])
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    const normalizedQuery = query.trim()

    if (!enabled || normalizedQuery.length < AUTOCOMPLETE_MIN_QUERY_LENGTH) {
      setSuggestions([])
      setIsLoading(false)
      return
    }

    let ignore = false
    setSuggestions([])
    setIsLoading(true)
    const timeoutId = window.setTimeout(async () => {
      try {
        const nextSuggestions = await fetchAddressSuggestions(normalizedQuery)

        if (!ignore) {
          setSuggestions(nextSuggestions)
        }
      } catch {
        if (!ignore) {
          setSuggestions([])
        }
      } finally {
        if (!ignore) {
          setIsLoading(false)
        }
      }
    }, AUTOCOMPLETE_DEBOUNCE_MS)

    return () => {
      ignore = true
      window.clearTimeout(timeoutId)
    }
  }, [enabled, query])

  return { suggestions, isLoading }
}

function AddressAutocompleteField({
  label,
  value,
  placeholder,
  isActive,
  isLoading,
  suggestions,
  onChange,
  onFocus,
  onBlur,
  onSelectSuggestion,
}: AddressAutocompleteFieldProps) {
  const showSuggestions = isActive && value.trim().length >= AUTOCOMPLETE_MIN_QUERY_LENGTH

  return (
    <div className="autocomplete-field">
      <label className="field field--with-suggestions">
        <span>{label}</span>
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={placeholder}
          autoComplete="off"
        />
      </label>
      {showSuggestions && (
        <div className="autocomplete-menu">
          {isLoading ? (
            <p className="autocomplete-status">Ieškoma adresų...</p>
          ) : suggestions.length > 0 ? (
            suggestions.map((suggestion) => (
              <button
                key={`${suggestion.label}-${suggestion.point.lat}-${suggestion.point.lng}`}
                type="button"
                className="autocomplete-option"
                onMouseDown={(event) => {
                  event.preventDefault()
                  onSelectSuggestion(suggestion)
                }}
              >
                {suggestion.label}
              </button>
            ))
          ) : (
            <p className="autocomplete-status">Neradome adresų pagal šią įvestį.</p>
          )}
        </div>
      )}
    </div>
  )
}

function compareNullableNumbers(
  left: number | null | undefined,
  right: number | null | undefined,
  direction: 'asc' | 'desc' = 'asc',
) {
  if (left === null || left === undefined) {
    return right === null || right === undefined ? 0 : 1
  }

  if (right === null || right === undefined) {
    return -1
  }

  return direction === 'desc' ? right - left : left - right
}

function compareStationNames(left: StationRecord, right: StationRecord) {
  return `${left.network}-${left.city}-${left.address}`.localeCompare(
    `${right.network}-${right.city}-${right.address}`,
    'lt',
  )
}

function stationMatchesListVisibility(
  station: StationRecord,
  fuelKey: FuelKey,
  listVisibility: ListVisibility,
  routeStationIds: Set<string>,
) {
  if (listVisibility === 'priced') {
    return station.prices[fuelKey] !== null
  }

  if (listVisibility === 'mapped') {
    return station.coordinates !== null
  }

  if (listVisibility === 'route') {
    return routeStationIds.has(station.id)
  }

  return true
}

function compareStations(
  left: StationRecord,
  right: StationRecord,
  fuelKey: FuelKey,
  routeCandidateMap: Map<string, RouteCandidate>,
) {
  const leftValue = left.prices[fuelKey]
  const rightValue = right.prices[fuelKey]

  if (leftValue === null && rightValue === null) {
    return (
      compareNullableNumbers(
        routeCandidateMap.get(left.id)?.detourDistanceKm ?? null,
        routeCandidateMap.get(right.id)?.detourDistanceKm ?? null,
      ) || compareStationNames(left, right)
    )
  }

  return (
    compareNullableNumbers(leftValue, rightValue) ||
    compareNullableNumbers(
      routeCandidateMap.get(left.id)?.detourDistanceKm ?? null,
      routeCandidateMap.get(right.id)?.detourDistanceKm ?? null,
    ) ||
    compareStationNames(left, right)
  )
}

function findCheapestStationForFuel(stations: StationRecord[], fuelKey: FuelKey) {
  let bestStation: StationRecord | null = null

  for (const station of stations) {
    if (station.prices[fuelKey] === null) {
      continue
    }

    if (
      !bestStation ||
      compareNullableNumbers(station.prices[fuelKey], bestStation.prices[fuelKey]) < 0 ||
      (station.prices[fuelKey] === bestStation.prices[fuelKey] &&
        compareStationNames(station, bestStation) < 0)
    ) {
      bestStation = station
    }
  }

  return bestStation
}

function calculateRouteCandidate(
  station: StationRecord,
  detourMetrics: RouteDetourResult | undefined,
  fuelKey: FuelKey,
  purchaseLiters: number,
  fuelConsumptionPer100Km: number,
) {
  if (!station.coordinates || !detourMetrics) {
    return null
  }

  const detourDistanceKm = detourMetrics.detourDistanceMeters / 1000
  const fuelPrice = station.prices[fuelKey]
  const detourFuelLiters = (detourDistanceKm * fuelConsumptionPer100Km) / 100
  const purchaseCost = fuelPrice === null ? null : purchaseLiters * fuelPrice
  const detourFuelCost = fuelPrice === null ? null : detourFuelLiters * fuelPrice
  const totalEstimatedCost =
    purchaseCost === null || detourFuelCost === null ? null : purchaseCost + detourFuelCost

  return {
    station,
    detourDistanceKm,
    detourDurationSeconds: detourMetrics.detourDurationSeconds,
    fuelPrice,
    purchaseLiters,
    purchaseCost,
    detourFuelLiters,
    detourFuelCost,
    totalEstimatedCost,
  } satisfies RouteCandidate
}

function calculateApproximateDetourLowerBoundKm(
  station: StationRecord,
  routeLine: ReturnType<typeof lineString>,
) {
  if (!station.coordinates) {
    return null
  }

  return (
    pointToLineDistance(point([station.coordinates.lng, station.coordinates.lat]), routeLine, {
      units: 'kilometers',
    }) * 2
  )
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

async function createRouteDetourStationsAsync(
  stations: StationRecord[],
  route: RouteResult,
  maxDetourKm: number,
  isCancelled: () => boolean,
) {
  const routeLine = lineString(route.geometry)
  const routeDetourStations: RouteDetourStation[] = []

  for (let startIndex = 0; startIndex < stations.length; startIndex += ROUTE_DETOUR_CHUNK_SIZE) {
    if (isCancelled()) {
      return null
    }

    const batch = stations.slice(startIndex, startIndex + ROUTE_DETOUR_CHUNK_SIZE)

    for (const station of batch) {
      const lowerBoundDetourKm = calculateApproximateDetourLowerBoundKm(station, routeLine)

      if (lowerBoundDetourKm === null || lowerBoundDetourKm > maxDetourKm) {
        continue
      }

      routeDetourStations.push({
        id: station.id,
        point: {
          lat: station.coordinates.lat,
          lng: station.coordinates.lng,
        },
      })
    }

    await yieldToBrowser()
  }

  return routeDetourStations
}

function formatRouteCalculationKeyPoint(pointValue: RoutePoint | null) {
  return pointValue ? `${pointValue.lat.toFixed(5)},${pointValue.lng.toFixed(5)}` : 'unset'
}

function createRouteCalculationKey({
  startPoint,
  endPoint,
  snapshotDate,
  networkFilter,
  municipalityFilter,
  blacklistedNetworks,
}: {
  startPoint: RoutePoint | null
  endPoint: RoutePoint | null
  snapshotDate: string | undefined
  networkFilter: string
  municipalityFilter: string
  blacklistedNetworks: string[]
}) {
  const normalizedBlacklist = [...blacklistedNetworks]
    .map((network) => normalizeNetworkName(network))
    .sort((left, right) => left.localeCompare(right, 'lt'))
    .join('|')

  return [
    snapshotDate ?? 'no-snapshot',
    formatRouteCalculationKeyPoint(startPoint),
    formatRouteCalculationKeyPoint(endPoint),
    networkFilter.trim().toLowerCase(),
    municipalityFilter.trim().toLowerCase(),
    normalizedBlacklist,
  ].join('::')
}

function App() {
  const [snapshot, setSnapshot] = useState<PriceSnapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [isLoadingSnapshot, setIsLoadingSnapshot] = useState(false)
  const [fuelKey, setFuelKey] = useState<FuelKey>('gasoline95')
  const [networkFilter, setNetworkFilter] = useState('')
  const [municipalityFilter, setMunicipalityFilter] = useState('')
  const [listVisibility, setListVisibility] = useState<ListVisibility>('all')
  const [selectionMode, setSelectionMode] = useState<'start' | 'end'>('start')
  const [pointInputMode, setPointInputMode] = useState<PointInputMode>('address')
  const [startPoint, setStartPoint] = useState<RoutePoint | null>(null)
  const [endPoint, setEndPoint] = useState<RoutePoint | null>(null)
  const [startAddress, setStartAddress] = useState('')
  const [endAddress, setEndAddress] = useState('')
  const [userLocation, setUserLocation] = useState<RoutePoint | null>(null)
  const [isLocatingUser, setIsLocatingUser] = useState(false)
  const [userLocationError, setUserLocationError] = useState<string | null>(null)
  const [blacklistedNetworks, setBlacklistedNetworks] = useState<string[]>(DEFAULT_BLACKLIST)
  const [blacklistInput, setBlacklistInput] = useState('')
  const [activeAddressField, setActiveAddressField] = useState<AddressFieldKey | null>(null)
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [displayRoute, setDisplayRoute] = useState<RouteResult | null>(null)
  const [routeError, setRouteError] = useState<string | null>(null)
  const [isLoadingRoute, setIsLoadingRoute] = useState(false)
  const [routeDetourError, setRouteDetourError] = useState<string | null>(null)
  const [isLoadingRouteDetours, setIsLoadingRouteDetours] = useState(false)
  const [routeDetours, setRouteDetours] = useState<RouteDetourResult[]>([])
  const [lastRouteCalculationKey, setLastRouteCalculationKey] = useState<string | null>(null)
  const [routeDisplayError, setRouteDisplayError] = useState<string | null>(null)
  const [isLoadingDisplayRoute, setIsLoadingDisplayRoute] = useState(false)
  const [isSnapshotRefreshCoolingDown, setIsSnapshotRefreshCoolingDown] = useState(false)
  const [focusedStationId, setFocusedStationId] = useState<string | null>(null)
  const [mapFocusTarget, setMapFocusTarget] = useState<MapFocusTarget | null>(null)
  const [corridorKm, setCorridorKm] = useState(DEFAULT_CORRIDOR_KM)
  const [plannedFuelLiters, setPlannedFuelLiters] = useState(DEFAULT_PLANNED_FUEL_LITERS)
  const [plannedFuelLitersInput, setPlannedFuelLitersInput] = useState(
    String(DEFAULT_PLANNED_FUEL_LITERS),
  )
  const [fuelConsumptionPer100Km, setFuelConsumptionPer100Km] = useState(
    DEFAULT_FUEL_CONSUMPTION_PER_100_KM,
  )
  const [fuelConsumptionPer100KmInput, setFuelConsumptionPer100KmInput] = useState(
    String(DEFAULT_FUEL_CONSUMPTION_PER_100_KM),
  )
  const [showAllDefaultResults, setShowAllDefaultResults] = useState(false)
  const snapshotRefreshCooldownTimerRef = useRef<number | null>(null)
  const routeCalculationRequestIdRef = useRef(0)
  const requestedUserLocationOnLoadRef = useRef(false)

  const networks = useMemo(() => {
    const values = new Set((snapshot?.stations ?? []).map((station) => station.network))
    return Array.from(values).sort((left, right) => left.localeCompare(right, 'lt'))
  }, [snapshot])

  const blacklistedNetworkKeys = useMemo(
    () => new Set(blacklistedNetworks.map((network) => normalizeNetworkName(network))),
    [blacklistedNetworks],
  )

  const selectableNetworks = useMemo(
    () =>
      networks.filter((network) => !blacklistedNetworkKeys.has(normalizeNetworkName(network))),
    [blacklistedNetworkKeys, networks],
  )

  const municipalities = useMemo(() => {
    const values = new Set((snapshot?.stations ?? []).map((station) => station.municipality))
    return Array.from(values).sort((left, right) => left.localeCompare(right, 'lt'))
  }, [snapshot])

  const filteredStations = useMemo(() => {
    const normalizedNetworkFilter = networkFilter.trim().toLowerCase()
    const normalizedMunicipalityFilter = municipalityFilter.trim().toLowerCase()

    return (snapshot?.stations ?? []).filter((station) => {
      if (blacklistedNetworkKeys.has(normalizeNetworkName(station.network))) {
        return false
      }

      if (
        normalizedNetworkFilter.length > 0 &&
        !station.network.toLowerCase().includes(normalizedNetworkFilter)
      ) {
        return false
      }

      if (
        normalizedMunicipalityFilter.length > 0 &&
        !station.municipality.toLowerCase().includes(normalizedMunicipalityFilter)
      ) {
        return false
      }

      return true
    })
  }, [blacklistedNetworkKeys, municipalityFilter, networkFilter, snapshot])

  const routeDetourMap = useMemo(
    () => new Map(routeDetours.map((detour) => [detour.stationId, detour])),
    [routeDetours],
  )

  const allRouteCandidates = useMemo(
    () =>
      filteredStations
        .map((station) =>
          calculateRouteCandidate(
            station,
            routeDetourMap.get(station.id),
            fuelKey,
            Math.max(plannedFuelLiters, 0),
            Math.max(fuelConsumptionPer100Km, 0),
          ),
        )
        .filter((candidate): candidate is RouteCandidate => candidate !== null),
    [filteredStations, fuelConsumptionPer100Km, fuelKey, plannedFuelLiters, routeDetourMap],
  )

  const routeCandidates = useMemo(
    () => allRouteCandidates.filter((candidate) => candidate.detourDistanceKm <= corridorKm),
    [allRouteCandidates, corridorKm],
  )

  const routeStationIds = useMemo(
    () => new Set(routeCandidates.map((candidate) => candidate.station.id)),
    [routeCandidates],
  )

  const routeCandidateMap = useMemo(
    () => new Map(routeCandidates.map((candidate) => [candidate.station.id, candidate])),
    [routeCandidates],
  )
  const distanceFromUserMap = useMemo(() => {
    if (!userLocation) {
      return new Map<string, number>()
    }

    return new Map(
      filteredStations.flatMap((station) =>
        station.coordinates
          ? [[
              station.id,
              calculateDistanceBetweenPointsKm(userLocation, {
                lat: station.coordinates.lat,
                lng: station.coordinates.lng,
              }),
            ]]
          : [],
      ),
    )
  }, [filteredStations, userLocation])

  const routeVisibleCandidates = useMemo(
    () =>
      routeCandidates.filter((candidate) =>
        stationMatchesListVisibility(candidate.station, fuelKey, listVisibility, routeStationIds),
      ),
    [fuelKey, listVisibility, routeCandidates, routeStationIds],
  )

  const listVisibleStations = useMemo(
    () =>
      filteredStations.filter((station) =>
        stationMatchesListVisibility(station, fuelKey, listVisibility, routeStationIds),
      ),
    [filteredStations, fuelKey, listVisibility, routeStationIds],
  )

  const bestRouteCandidate = useMemo(() => {
    const comparableCandidates = routeVisibleCandidates.filter(
      (candidate) => candidate.totalEstimatedCost !== null,
    )

    if (comparableCandidates.length === 0) {
      return null
    }

    return comparableCandidates.reduce((bestCandidate, candidate) => {
      if (!bestCandidate) {
        return candidate
      }

      if (candidate.totalEstimatedCost! < bestCandidate.totalEstimatedCost!) {
        return candidate
      }

        if (
          candidate.totalEstimatedCost === bestCandidate.totalEstimatedCost &&
          candidate.detourDistanceKm < bestCandidate.detourDistanceKm
        ) {
          return candidate
        }

      return bestCandidate
    }, null as RouteCandidate | null)
  }, [routeVisibleCandidates])
  const featuredStationId = bestRouteCandidate?.station.id ?? null
  const routeDisplayStationId =
    focusedStationId && routeCandidateMap.has(focusedStationId) ? focusedStationId : featuredStationId
  const routeDisplayCandidate = routeDisplayStationId
    ? routeCandidateMap.get(routeDisplayStationId) ?? null
    : null

  const sortedFilteredStations = useMemo(
    () =>
      [...listVisibleStations].sort((left, right) =>
        compareStations(left, right, fuelKey, routeCandidateMap),
      ),
    [fuelKey, listVisibleStations, routeCandidateMap],
  )

  const sortedRouteStations = useMemo(
    () =>
      routeVisibleCandidates
        .map((candidate) => candidate.station)
        .sort((left, right) => compareStations(left, right, fuelKey, routeCandidateMap)),
    [fuelKey, routeCandidateMap, routeVisibleCandidates],
  )
  const isUsingDefaultBlacklist = useMemo(() => {
    if (blacklistedNetworks.length !== DEFAULT_BLACKLIST.length) {
      return false
    }

    const defaultBlacklistKeys = new Set(DEFAULT_BLACKLIST.map((network) => normalizeNetworkName(network)))

    return blacklistedNetworks.every((network) =>
      defaultBlacklistKeys.has(normalizeNetworkName(network)),
    )
  }, [blacklistedNetworks])
  const isDefaultDiscoveryState =
    route === null &&
    networkFilter.trim().length === 0 &&
    municipalityFilter.trim().length === 0 &&
    listVisibility === 'all' &&
    isUsingDefaultBlacklist
  const isShowingCuratedStations =
    isDefaultDiscoveryState &&
    !showAllDefaultResults &&
    sortedFilteredStations.length > DEFAULT_DISCOVERY_RESULTS_LIMIT

  const displayedStations = useMemo(() => {
    if (isShowingCuratedStations) {
      return sortedFilteredStations.slice(0, DEFAULT_DISCOVERY_RESULTS_LIMIT)
    }

    if (!route) {
      return sortedFilteredStations
    }

    return sortedRouteStations
  }, [isShowingCuratedStations, route, sortedFilteredStations, sortedRouteStations])

  const topStationId = displayedStations.at(0)?.id ?? null
  const activePointSelectionMode = pointInputMode === 'map' ? selectionMode : 'none'
  const isStartAutocompleteActive =
    pointInputMode === 'address' && activeAddressField === 'start'
  const isEndAutocompleteActive = pointInputMode === 'address' && activeAddressField === 'end'
  const { suggestions: startSuggestions, isLoading: isLoadingStartSuggestions } =
    useAddressSuggestions(startAddress, isStartAutocompleteActive)
  const { suggestions: endSuggestions, isLoading: isLoadingEndSuggestions } = useAddressSuggestions(
    endAddress,
    isEndAutocompleteActive,
  )
  const hiddenStationCount = useMemo(
    () =>
      (snapshot?.stations ?? []).filter((station) =>
        blacklistedNetworkKeys.has(normalizeNetworkName(station.network)),
      ).length,
    [blacklistedNetworkKeys, snapshot],
  )
  const nearbyHeroStations = useMemo(
    () =>
      userLocation
        ? filteredStations.filter((station) => {
            const distanceKm = distanceFromUserMap.get(station.id)
            return distanceKm !== undefined && distanceKm <= NEARBY_CONTEXT_RADIUS_KM
          })
        : filteredStations,
    [distanceFromUserMap, filteredStations, userLocation],
  )
  const cheapestStationsByFuel = useMemo(
    () =>
      FUEL_KEYS.reduce(
        (accumulator, key) => {
          accumulator[key] = findCheapestStationForFuel(nearbyHeroStations, key)
          return accumulator
        },
        {} as Record<FuelKey, StationRecord | null>,
      ),
    [nearbyHeroStations],
  )
  const currentRouteCalculationKey = useMemo(
    () =>
      createRouteCalculationKey({
        startPoint,
        endPoint,
        snapshotDate: snapshot?.snapshotDate,
        networkFilter,
        municipalityFilter,
        blacklistedNetworks,
      }),
    [
      blacklistedNetworks,
      endPoint,
      municipalityFilter,
      networkFilter,
      snapshot?.snapshotDate,
      startPoint,
    ],
  )
  const isRouteCalculationStale =
    route !== null && lastRouteCalculationKey !== null && currentRouteCalculationKey !== lastRouteCalculationKey

  useEffect(() => {
    if (!route || !startPoint || !endPoint) {
      setDisplayRoute(null)
      setRouteDisplayError(null)
      setIsLoadingDisplayRoute(false)
      return
    }

    if (!routeDisplayCandidate?.station.coordinates) {
      setDisplayRoute(route)
      setRouteDisplayError(null)
      setIsLoadingDisplayRoute(false)
      return
    }

    let ignore = false
    setDisplayRoute(route)
    setRouteDisplayError(null)
    setIsLoadingDisplayRoute(true)

    void (async () => {
      try {
        const nextDisplayRoute = await fetchRoute(startPoint, endPoint, {
          lat: routeDisplayCandidate.station.coordinates!.lat,
          lng: routeDisplayCandidate.station.coordinates!.lng,
        })

        if (!ignore) {
          setDisplayRoute(nextDisplayRoute)
        }
      } catch (error) {
        if (!ignore) {
          setDisplayRoute(route)
          setRouteDisplayError(
            error instanceof Error
              ? error.message
              : 'Nepavyko parodyti maršruto per pasirinktą degalinę.',
          )
        }
      } finally {
        if (!ignore) {
          setIsLoadingDisplayRoute(false)
        }
      }
    })()

    return () => {
      ignore = true
    }
  }, [endPoint, route, routeDisplayCandidate, startPoint])

  useEffect(() => {
    if (!focusedStationId) {
      return
    }

    const stillDisplayed = displayedStations.some((station) => station.id === focusedStationId)

    if (!stillDisplayed) {
      setFocusedStationId(null)
      setMapFocusTarget(null)
    }
  }, [displayedStations, focusedStationId])

  useEffect(() => {
    if (networkFilter && blacklistedNetworkKeys.has(normalizeNetworkName(networkFilter))) {
      setNetworkFilter('')
    }
  }, [blacklistedNetworkKeys, networkFilter])

  useEffect(() => {
    if (!isDefaultDiscoveryState) {
      setShowAllDefaultResults(false)
    }
  }, [isDefaultDiscoveryState])

  useEffect(() => {
    return () => {
      if (snapshotRefreshCooldownTimerRef.current !== null) {
        window.clearTimeout(snapshotRefreshCooldownTimerRef.current)
      }
    }
  }, [])

  const handleFetchSnapshot = useCallback(async (forceRefresh = false) => {
    setIsLoadingSnapshot(true)
    setSnapshotError(null)

    try {
      const nextSnapshot = await fetchLatestPricesWithOptions({ forceRefresh })
      setSnapshot(nextSnapshot)
      setFocusedStationId(null)
      setMapFocusTarget(null)
    } catch (error) {
      setSnapshotError(
        error instanceof Error ? error.message : 'Nepavyko gauti paskelbtų kainų duomenų.',
      )
    } finally {
      setIsLoadingSnapshot(false)
    }
  }, [])

  const handleManualSnapshotRefresh = useCallback(() => {
    if (isLoadingSnapshot || isSnapshotRefreshCoolingDown) {
      return
    }

    setIsSnapshotRefreshCoolingDown(true)

    if (snapshotRefreshCooldownTimerRef.current !== null) {
      window.clearTimeout(snapshotRefreshCooldownTimerRef.current)
    }

    snapshotRefreshCooldownTimerRef.current = window.setTimeout(() => {
      setIsSnapshotRefreshCoolingDown(false)
      snapshotRefreshCooldownTimerRef.current = null
    }, SNAPSHOT_REFRESH_DEBOUNCE_MS)

    void handleFetchSnapshot(true)
  }, [handleFetchSnapshot, isLoadingSnapshot, isSnapshotRefreshCoolingDown])

  useEffect(() => {
    void handleFetchSnapshot()
  }, [handleFetchSnapshot])

  async function handleFetchRoute() {
    const requestId = routeCalculationRequestIdRef.current + 1
    routeCalculationRequestIdRef.current = requestId
    setIsLoadingRoute(true)
    setRouteError(null)
    setRouteDetourError(null)
    setRouteDetours([])

    try {
      let nextStartPoint = startPoint
      let nextEndPoint = endPoint

      if (pointInputMode === 'address') {
        if (!startAddress.trim() || !endAddress.trim()) {
          setRouteError('Pirmiausia įveskite abu adresus A ir B.')
          setIsLoadingRoute(false)
          return
        }

        if (!nextStartPoint || !nextEndPoint) {
          const [geocodedStartPoint, geocodedEndPoint] = await Promise.all([
            nextStartPoint ? Promise.resolve(nextStartPoint) : fetchAddressPoint(startAddress),
            nextEndPoint ? Promise.resolve(nextEndPoint) : fetchAddressPoint(endAddress),
          ])

          nextStartPoint = geocodedStartPoint
          nextEndPoint = geocodedEndPoint
          setStartPoint(geocodedStartPoint)
          setEndPoint(geocodedEndPoint)
        }
      }

      if (!nextStartPoint || !nextEndPoint) {
        setRouteError('Pirmiausia pasirinkite abu taškus A ir B žemėlapyje.')
        setIsLoadingRoute(false)
        return
      }

      const nextRoute = await fetchRoute(nextStartPoint, nextEndPoint)
      const nextRouteCalculationKey = createRouteCalculationKey({
        startPoint: nextStartPoint,
        endPoint: nextEndPoint,
        snapshotDate: snapshot?.snapshotDate,
        networkFilter,
        municipalityFilter,
        blacklistedNetworks,
      })

      setRoute(nextRoute)
      setDisplayRoute(nextRoute)
      setFocusedStationId(null)
      setMapFocusTarget(null)
      setLastRouteCalculationKey(nextRouteCalculationKey)
      setIsLoadingRouteDetours(true)
      setIsLoadingRoute(false)
      await yieldToBrowser()

      if (routeCalculationRequestIdRef.current !== requestId) {
        return
      }

      const nextRouteDetourStations = await createRouteDetourStationsAsync(
        filteredStations,
        nextRoute,
        MAX_CORRIDOR_KM,
        () => routeCalculationRequestIdRef.current !== requestId,
      )

      if (routeCalculationRequestIdRef.current !== requestId || !nextRouteDetourStations) {
        return
      }

      if (nextRouteDetourStations.length === 0) {
        setRouteDetours([])
        setIsLoadingRouteDetours(false)
        return
      }

      try {
        const nextRouteDetours = await fetchRouteDetours(
          nextStartPoint,
          nextEndPoint,
          nextRouteDetourStations,
        )

        if (routeCalculationRequestIdRef.current !== requestId) {
          return
        }

        setRouteDetours(nextRouteDetours)
      } catch (error) {
        if (routeCalculationRequestIdRef.current !== requestId) {
          return
        }

        setRouteDetours([])
        setRouteDetourError(
          error instanceof Error
            ? error.message
            : 'Nepavyko tiksliai apskaičiuoti papildomo kelio iki stotelių.',
        )
      } finally {
        if (routeCalculationRequestIdRef.current === requestId) {
          setIsLoadingRouteDetours(false)
        }
      }
    } catch (error) {
      if (routeCalculationRequestIdRef.current !== requestId) {
        return
      }

      setRouteError(
        error instanceof Error
          ? error.message
          : 'Nepavyko apskaičiuoti maršruto pagal pasirinktus taškus.',
      )
    } finally {
      if (routeCalculationRequestIdRef.current === requestId) {
        setIsLoadingRoute(false)
      }
    }
  }

  function handleMapPick(pointValue: RoutePoint) {
    if (pointInputMode !== 'map') {
      return
    }

    if (selectionMode === 'start') {
      setStartPoint(pointValue)
      setSelectionMode('end')
      return
    }

    setEndPoint(pointValue)
  }

  function handleAddressChange(field: AddressFieldKey, value: string) {
    setRouteError(null)

    if (field === 'start') {
      setStartAddress(value)
      setStartPoint(null)
      return
    }

    setEndAddress(value)
    setEndPoint(null)
  }

  function handleAddressSuggestionSelect(field: AddressFieldKey, suggestion: AddressSuggestion) {
    setRouteError(null)

    if (field === 'start') {
      setStartAddress(suggestion.label)
      setStartPoint(suggestion.point)
    } else {
      setEndAddress(suggestion.label)
      setEndPoint(suggestion.point)
    }

    setActiveAddressField(null)
  }

  function handleAddressBlur(field: AddressFieldKey) {
    if (activeAddressField === field) {
      setActiveAddressField(null)
    }
  }

  const handleRequestUserLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setUserLocationError('Jūsų naršyklė nepalaiko vietos nustatymo.')
      return
    }

    setIsLocatingUser(true)
    setUserLocationError(null)

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        })
        setIsLocatingUser(false)
      },
      (error) => {
        const errorMessage =
          error.code === error.PERMISSION_DENIED
            ? 'Vietos leidimas nebuvo suteiktas.'
            : 'Nepavyko nustatyti jūsų vietos.'
        setUserLocationError(errorMessage)
        setIsLocatingUser(false)
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 1000 * 60 * 5,
      },
    )
  }, [])

  useEffect(() => {
    if (requestedUserLocationOnLoadRef.current) {
      return
    }

    requestedUserLocationOnLoadRef.current = true
    handleRequestUserLocation()
  }, [handleRequestUserLocation])

  function handleUseCurrentLocationAsStart() {
    if (!userLocation) {
      handleRequestUserLocation()
      return
    }

    setPointInputMode('address')
    setStartPoint(userLocation)
    setStartAddress('Mano vieta')
    setRouteError(null)
  }

  function handlePlannedFuelLitersChange(value: string) {
    setPlannedFuelLitersInput(value)

    const parsedValue = parseNumberInputValue(value)

    if (parsedValue !== null) {
      setPlannedFuelLiters(Math.max(parsedValue, 1))
    }
  }

  function handlePlannedFuelLitersBlur() {
    setPlannedFuelLitersInput(String(plannedFuelLiters))
  }

  function handleFuelConsumptionChange(value: string) {
    setFuelConsumptionPer100KmInput(value)

    const parsedValue = parseNumberInputValue(value)

    if (parsedValue !== null) {
      setFuelConsumptionPer100Km(Math.max(parsedValue, 0.1))
    }
  }

  function handleFuelConsumptionBlur() {
    setFuelConsumptionPer100KmInput(String(fuelConsumptionPer100Km))
  }

  function handleAddBlacklistedNetwork() {
    const trimmedValue = blacklistInput.trim()

    if (!trimmedValue) {
      return
    }

    const matchedNetwork =
      networks.find((network) => normalizeNetworkName(network) === normalizeNetworkName(trimmedValue)) ??
      trimmedValue

    setBlacklistedNetworks((previousNetworks) => addBlacklistedNetwork(previousNetworks, matchedNetwork))
    setBlacklistInput('')
  }

  function handleRemoveBlacklistedNetwork(network: string) {
    setBlacklistedNetworks((previousNetworks) =>
      previousNetworks.filter(
        (candidateNetwork) => normalizeNetworkName(candidateNetwork) !== normalizeNetworkName(network),
      ),
    )
  }

  function handleClearRoute() {
    routeCalculationRequestIdRef.current += 1
    setRoute(null)
    setDisplayRoute(null)
    setRouteError(null)
    setRouteDetourError(null)
    setRouteDisplayError(null)
    setRouteDetours([])
    setLastRouteCalculationKey(null)
    setIsLoadingRoute(false)
    setIsLoadingRouteDetours(false)
    setIsLoadingDisplayRoute(false)
    setFocusedStationId(null)
    setMapFocusTarget(null)
    setActiveAddressField(null)
    setStartAddress('')
    setEndAddress('')
    setStartPoint(null)
    setEndPoint(null)
    setUserLocationError(null)
    setCorridorKm(DEFAULT_CORRIDOR_KM)
    setPlannedFuelLiters(DEFAULT_PLANNED_FUEL_LITERS)
    setPlannedFuelLitersInput(String(DEFAULT_PLANNED_FUEL_LITERS))
    setFuelConsumptionPer100Km(DEFAULT_FUEL_CONSUMPTION_PER_100_KM)
    setFuelConsumptionPer100KmInput(String(DEFAULT_FUEL_CONSUMPTION_PER_100_KM))
    setSelectionMode('start')
  }

  function handleFocusStation(station: StationRecord) {
    if (!station.coordinates) {
      return
    }

    setFocusedStationId(station.id)
    setMapFocusTarget((previousTarget) => ({
      stationId: station.id,
      requestId: (previousTarget?.requestId ?? 0) + 1,
    }))
  }

  const isResolvingRoute = isLoadingRoute || isLoadingRouteDetours || isLoadingDisplayRoute
  const heroHeadline = route && bestRouteCandidate ? 'Kur pigiausia užsipilti pakeliui?' : 'Kur pigiausia užsipilti šiandien?'
  const heroFuelStripNote = userLocation
    ? `Pagal dabartinius filtrus ir iki ${NEARBY_CONTEXT_RADIUS_KM} km nuo jūsų vietos.`
    : 'Pagal dabartinius filtrus visoje Lietuvoje.'
  const resultsTitleCount = isShowingCuratedStations
    ? `${displayedStations.length} iš ${sortedFilteredStations.length}`
    : String(displayedStations.length)

  const routePanel = (
    <section className="panel">
      <h2>Maršrutas ir stotelės</h2>
      <p className="panel-note">
        Taškus galite įvesti adresais arba pasirinkti žemėlapyje. Geriausias sustojimas vertinamas
        pagal pasirinktą kuro rūšį, planuojamą litražą ir tiksliai apskaičiuotą papildomą kelią.
      </p>
      <div className="toggle-group">
        <button
          type="button"
          className={
            pointInputMode === 'address' ? 'toggle-button toggle-button--active' : 'toggle-button'
          }
          onClick={() => {
            setPointInputMode('address')
            setActiveAddressField(null)
          }}
        >
          Įvesti A ir B adresus
        </button>
        <button
          type="button"
          className={
            pointInputMode === 'map' ? 'toggle-button toggle-button--active' : 'toggle-button'
          }
          onClick={() => {
            setPointInputMode('map')
            setActiveAddressField(null)
          }}
        >
          Rinkti taškus žemėlapyje
        </button>
      </div>
      {pointInputMode === 'map' ? (
        <div className="route-actions">
          <button
            type="button"
            className={
              selectionMode === 'start'
                ? 'secondary-button secondary-button--active'
                : 'secondary-button'
            }
            onClick={() => setSelectionMode('start')}
          >
            Rinkti tašką A
          </button>
          <button
            type="button"
            className={
              selectionMode === 'end'
                ? 'secondary-button secondary-button--active'
                : 'secondary-button'
            }
            onClick={() => setSelectionMode('end')}
          >
            Rinkti tašką B
          </button>
        </div>
      ) : (
        <div className="address-entry">
          <AddressAutocompleteField
            label="Adresas A"
            value={startAddress}
            placeholder="Pvz. Gedimino pr. 1, Vilnius"
            isActive={isStartAutocompleteActive}
            isLoading={isLoadingStartSuggestions}
            suggestions={startSuggestions}
            onChange={(value) => handleAddressChange('start', value)}
            onFocus={() => setActiveAddressField('start')}
            onBlur={() => handleAddressBlur('start')}
            onSelectSuggestion={(suggestion) => handleAddressSuggestionSelect('start', suggestion)}
          />
          <AddressAutocompleteField
            label="Adresas B"
            value={endAddress}
            placeholder="Pvz. Laisvės al. 1, Kaunas"
            isActive={isEndAutocompleteActive}
            isLoading={isLoadingEndSuggestions}
            suggestions={endSuggestions}
            onChange={(value) => handleAddressChange('end', value)}
            onFocus={() => setActiveAddressField('end')}
            onBlur={() => handleAddressBlur('end')}
            onSelectSuggestion={(suggestion) => handleAddressSuggestionSelect('end', suggestion)}
          />
        </div>
      )}
      <div className="route-utility-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={handleUseCurrentLocationAsStart}
          disabled={isLocatingUser}
        >
          Naudoti mano vietą taškui A
        </button>
      </div>
      {userLocation && (
        <p className="panel-note">{`Jūsų vieta: ${formatPoint(userLocation, 'Nėra vietos duomenų')}`}</p>
      )}
      {userLocationError && <p className="route-error">{userLocationError}</p>}
      <label className="field">
        <span>{`Maksimalus papildomas kelias: ${corridorKm.toFixed(1)} km`}</span>
        <input
          type="range"
            min="0.5"
            max={MAX_CORRIDOR_KM}
          step="0.5"
          value={corridorKm}
          onChange={(event) => setCorridorKm(Number(event.target.value))}
        />
      </label>
      <div className="field-grid field-grid--compact">
        <label className="field field--compact">
          <span>Planuojamas pirkimas (litrai)</span>
          <input
            type="number"
            min="1"
            step="1"
            value={plannedFuelLitersInput}
            onChange={(event) => handlePlannedFuelLitersChange(event.target.value)}
            onBlur={handlePlannedFuelLitersBlur}
            onFocus={(event) => event.target.select()}
          />
        </label>
        <label className="field field--compact">
          <span>Sąnaudos l/100 km</span>
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={fuelConsumptionPer100KmInput}
            onChange={(event) => handleFuelConsumptionChange(event.target.value)}
            onBlur={handleFuelConsumptionBlur}
            onFocus={(event) => event.target.select()}
          />
        </label>
      </div>
      <div className="route-actions">
        <button
          type="button"
          className="primary-button"
          onClick={handleFetchRoute}
          disabled={isResolvingRoute || filteredStations.length === 0}
        >
          {isResolvingRoute ? 'Skaičiuojama...' : 'Rasti degalines palei maršrutą'}
        </button>
        <button type="button" className="secondary-button" onClick={handleClearRoute}>
          Išvalyti
        </button>
      </div>
      {route && (
        <p className="route-stats">
          {`Maršrutas: ${formatDistance(route.distanceMeters)} • ${formatDuration(route.durationSeconds)}`}
        </p>
      )}
      {routeDisplayCandidate && displayRoute && (
        <p className="route-stats">
          {`${focusedStationId === routeDisplayStationId ? 'Maršrutas per pasirinktą stotelę' : 'Maršrutas per geriausią stotelę'}: ${formatDistance(displayRoute.distanceMeters)} • ${formatDuration(displayRoute.durationSeconds)} (+${formatKilometers(routeDisplayCandidate.detourDistanceKm)} • +${formatDuration(routeDisplayCandidate.detourDurationSeconds)})`}
        </p>
      )}
      {routeError && <p className="route-error">{routeError}</p>}
      {routeDetourError && <p className="route-error">{routeDetourError}</p>}
      {routeDisplayError && <p className="route-error">{routeDisplayError}</p>}
      {route && isRouteCalculationStale && (
        <p className="panel-note">
          Pakeitėte maršruto taškus arba filtrus. Paspauskite „Rasti degalines palei maršrutą“, kad
          rezultatai būtų perskaičiuoti.
        </p>
      )}
      {route && (isLoadingRouteDetours || isLoadingDisplayRoute) && (
        <p className="panel-note">Tikslinami papildomo kelio skaičiavimai pagal realų kelių maršrutą.</p>
      )}
    </section>
  )

  return (
    <div className="app-shell">
      <header className="hero">
        <section className="hero-banner">
          <div className="hero-banner__top">
            <div className="hero-banner__copy">
              <p className="eyebrow">Lietuvos degalų palyginimas</p>
              <h1>{heroHeadline}</h1>
              <p className="hero-copy">
                LEA kainos, maršruto sustojimai ir artimiausios stotelės viename trumpame vaizde.
              </p>
            </div>
            <div className="hero-actions">
              <button
                type="button"
                className="primary-button"
                onClick={handleManualSnapshotRefresh}
                disabled={isLoadingSnapshot || isSnapshotRefreshCoolingDown}
              >
                {isLoadingSnapshot
                  ? 'Kraunama...'
                  : isSnapshotRefreshCoolingDown
                    ? 'Palaukite...'
                    : 'Atnaujinti paskelbtus duomenis'}
              </button>
            </div>
          </div>
          {snapshot && (
            <div className="hero-banner__meta">
              <span>{`Duomenys už ${snapshot.snapshotDate}`}</span>
              <span>{`Atnaujinta ${formatDateTime(snapshot.fetchedAt)}`}</span>
              <a href={snapshot.sourceUrl} target="_blank" rel="noreferrer">
                Excel šaltinis
              </a>
            </div>
          )}
          <section className="hero-fuel-strip" aria-label="Pigiausi variantai pagal kurą">
            <div className="hero-fuel-strip__header">
              <div>
                <span className="hero-fuel-strip__label">Pigiausi variantai pagal kurą</span>
                <h2>Kas šiandien pirmauja?</h2>
              </div>
              <p className="hero-fuel-strip__note">{heroFuelStripNote}</p>
            </div>
            <div className="hero-fuel-grid">
              {FUEL_KEYS.map((key) => {
                const station = cheapestStationsByFuel[key]
                const distanceFromUserKm = station && userLocation ? distanceFromUserMap.get(station.id) : null

                return (
                  <article key={key} className="hero-fuel-card">
                    <div className="hero-fuel-card__top">
                      <span className="hero-fuel-card__label">{FUEL_LABELS[key]}</span>
                      <strong>{station ? formatFuelPrice(station.prices[key]) : 'N/A'}</strong>
                    </div>
                    {station ? (
                      <>
                        <p className="hero-fuel-card__name">{station.network}</p>
                        <p className="hero-fuel-card__meta">{`${station.city} • ${station.address}`}</p>
                        <p className="hero-fuel-card__meta">
                          {distanceFromUserKm !== null && distanceFromUserKm !== undefined
                            ? `Nuo jūsų: ${formatKilometers(distanceFromUserKm)}`
                            : station.municipality}
                        </p>
                      </>
                    ) : (
                      <p className="hero-fuel-card__meta">
                        {userLocation
                          ? `Per ${NEARBY_CONTEXT_RADIUS_KM} km neradome šio kuro kainos.`
                          : 'Pagal dabartinius filtrus kainos nėra.'}
                      </p>
                    )}
                  </article>
                )
              })}
            </div>
          </section>
          {snapshot && (
            <p className="hero-source-note">
              Duomenys: LEA. Pirminiai šaltiniai - degalinių tinklus valdančios įmonės.
            </p>
          )}
          {userLocationError && <p className="hero-inline-error">{userLocationError}</p>}
        </section>
      </header>

      {snapshotError && <p className="status-banner status-banner--error">{snapshotError}</p>}
      {!snapshot && !snapshotError && (
        <p className="status-banner">
          Dar nėra paskelbto duomenų rinkinio. Pirmiausia paleiskite administratoriaus refresh
          komandą arba apsaugotą refresh endpointą.
        </p>
      )}
      {snapshot?.locationNotes.map((note) => (
        <p key={note} className="status-banner status-banner--warning">
          {note}
        </p>
      ))}

      <div className="content-grid">
        <aside className="sidebar">
          <section className="panel">
            <h2>Filtrai</h2>
            <label className="field">
              <span>Kuras</span>
              <select
                value={fuelKey}
                onChange={(event) => setFuelKey(event.target.value as FuelKey)}
              >
                {FUEL_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {FUEL_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Tinklas</span>
              <input
                type="search"
                list="network-filter-options"
                value={networkFilter}
                onChange={(event) => setNetworkFilter(event.target.value)}
                placeholder="Visi tinklai"
              />
              <datalist id="network-filter-options">
                {selectableNetworks.map((network) => (
                  <option key={network} value={network} />
                ))}
              </datalist>
            </label>
            <label className="field">
              <span>Savivaldybė</span>
              <input
                type="search"
                list="municipality-filter-options"
                value={municipalityFilter}
                onChange={(event) => setMunicipalityFilter(event.target.value)}
                placeholder="Visa Lietuva"
              />
              <datalist id="municipality-filter-options">
                {municipalities.map((municipality) => (
                  <option key={municipality} value={municipality} />
                ))}
              </datalist>
            </label>
            <label className="field">
              <span>Sąraše rodyti</span>
              <select
                value={listVisibility}
                onChange={(event) => setListVisibility(event.target.value as ListVisibility)}
              >
                <option value="all">Visas stoteles</option>
                <option value="priced">Tik su pasirinkto kuro kaina</option>
                <option value="mapped">Tik su koordinatėmis</option>
                <option value="route">Tik palei maršrutą</option>
              </select>
            </label>
          </section>

          <section className="panel">
            <h2>Degalinių juodasis sąrašas</h2>
            <p className="panel-note">
              Šio sąrašo tinklai nerodomi žemėlapyje ir neįtraukiami į maršruto bei sąrašo
              rezultatus. <strong>Jozita</strong> įtraukta pagal nutylėjimą.
            </p>
            <div className="blacklist-add">
              <label className="field field--with-suggestions">
                <span>Pridėti tinklą</span>
                <input
                  type="text"
                  list="network-blacklist-options"
                  value={blacklistInput}
                  onChange={(event) => setBlacklistInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      handleAddBlacklistedNetwork()
                    }
                  }}
                  placeholder="Pvz. Viada"
                />
              </label>
              <button
                type="button"
                className="secondary-button"
                onClick={handleAddBlacklistedNetwork}
                disabled={!blacklistInput.trim()}
              >
                Pridėti
              </button>
              <datalist id="network-blacklist-options">
                {selectableNetworks.map((network) => (
                  <option key={network} value={network} />
                ))}
              </datalist>
            </div>
            {blacklistedNetworks.length > 0 ? (
              <div className="blacklist-list">
                {blacklistedNetworks.map((network) => (
                  <span key={network} className="blacklist-chip">
                    <span>{network}</span>
                    <button
                      type="button"
                      aria-label={`Pašalinti ${network} iš juodojo sąrašo`}
                      onClick={() => handleRemoveBlacklistedNetwork(network)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="panel-note">Juodasis sąrašas šiuo metu tuščias.</p>
            )}
            <p className="panel-note">{`Šiuo metu paslėpta stotelių: ${hiddenStationCount}`}</p>
          </section>
        </aside>

        <main className="main-column">
          {routePanel}

          <RouteMap
            stations={sortedFilteredStations}
            route={displayRoute ?? route}
            activeSelection={activePointSelectionMode}
            routeStationIds={routeStationIds}
            topStationId={topStationId}
            featuredStationId={featuredStationId}
            focusedStationId={focusedStationId}
            focusTarget={mapFocusTarget}
            currentLocation={userLocation}
            startPoint={startPoint}
            endPoint={endPoint}
            onMapPick={handleMapPick}
          />

          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>{`Stotelių pasiūlymai (${resultsTitleCount})`}</h2>
                <p className="panel-note">
                  {isShowingCuratedStations ? (
                    <>
                      Rodome <strong>{DEFAULT_DISCOVERY_RESULTS_LIMIT} pigiausių</strong> variantų
                      pagal <strong>{FUEL_LABELS[fuelKey]}</strong>. Jei norite, galite išskleisti
                      visą sąrašą.
                    </>
                  ) : (
                    <>
                      Rodoma pagal <strong>{FUEL_LABELS[fuelKey]}</strong>, o kortelės išrikiuotos
                      nuo pigiausios kainos.
                    </>
                  )}
                </p>
              </div>
              {route && (
                <div className="route-chip">
                  <strong>{routeVisibleCandidates.length}</strong>
                  <span>matomų maršruto kandidatų</span>
                </div>
              )}
            </div>

            {isShowingCuratedStations && (
              <div className="results-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setShowAllDefaultResults(true)}
                >
                  {`Rodyti visas ${sortedFilteredStations.length} stoteles`}
                </button>
              </div>
            )}

            {displayedStations.length === 0 ? (
              <p className="empty-state">
                {route && isLoadingRouteDetours
                  ? 'Tikslinami maršruto stotelių skaičiavimai pagal realų kelių maršrutą.'
                  : route
                  ? 'Neradome maršruto stotelių pagal pasirinktus filtrus ir kelionės nustatymus.'
                  : 'Kol kas nėra rodomų stotelių pagal pasirinktus filtrus.'}
              </p>
            ) : (
              <div className="station-card-list">
                {displayedStations.map((station) => {
                  const isOnRoute = routeStationIds.has(station.id)
                  const isTopStation = station.id === topStationId
                  const isBestStation = station.id === featuredStationId
                  const isFocusedStation = station.id === focusedStationId
                  const routeCandidate = routeCandidateMap.get(station.id)
                  const canFocusOnMap = station.coordinates !== null
                  const distanceFromUserKm = distanceFromUserMap.get(station.id)
                  const stationStatusLabel = isBestStation
                    ? 'Pasiūlytas sustojimas'
                    : isOnRoute
                      ? 'Tinka kelionei'
                      : station.coordinates
                        ? 'Galima peržiūrėti žemėlapyje'
                        : 'Trūksta koordinačių'

                  return (
                    <article
                      key={station.id}
                      className={[
                        'station-card',
                        isTopStation ? 'station-card--top' : '',
                        isOnRoute ? 'station-card--highlight' : '',
                        isBestStation ? 'station-card--best' : '',
                        isFocusedStation ? 'station-card--focused' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <div className="station-card__header">
                        <div>
                          <div className="station-card__badges">
                            {isFocusedStation ? (
                              <span className="route-pill route-pill--focus">Žiūrima žemėlapyje</span>
                            ) : isBestStation ? (
                              <span className="route-pill route-pill--best">Geriausias pasirinkimas</span>
                            ) : isTopStation ? (
                              <span className="route-pill route-pill--top">Pigiausia sąraše</span>
                            ) : null}
                            {isOnRoute && <span className="route-pill route-pill--on">Pakeliui</span>}
                            {!station.coordinates && <span className="route-pill">Be koord.</span>}
                          </div>
                          <h3 className="station-card__title">{station.network}</h3>
                          <p className="station-card__address">{station.address}</p>
                          <p className="station-card__sub">{`${station.city} • ${station.municipality}`}</p>
                        </div>
                        <button
                          type="button"
                          className="secondary-button station-card__action"
                          onClick={() => handleFocusStation(station)}
                          disabled={!canFocusOnMap}
                        >
                          {isFocusedStation ? 'Pažymėta žemėlapyje' : 'Rodyti žemėlapyje'}
                        </button>
                      </div>

                      <div className="station-card__summary">
                        <div className="station-card__metric">
                          <span>{FUEL_LABELS[fuelKey]}</span>
                          <strong>{formatFuelPrice(station.prices[fuelKey])}</strong>
                        </div>
                        {routeCandidate ? (
                          <div className="station-card__metric station-card__metric--accent">
                            <span>Visa sustojimo kaina</span>
                            <strong>{formatMoney(routeCandidate.totalEstimatedCost)}</strong>
                          </div>
                        ) : distanceFromUserKm !== undefined ? (
                          <div className="station-card__metric">
                            <span>Atstumas nuo jūsų</span>
                            <strong>{formatKilometers(distanceFromUserKm)}</strong>
                          </div>
                        ) : null}
                      </div>

                      <div className="station-card__details">
                        {routeCandidate && (
                          <span>{`Papildomas kelias: ${formatKilometers(routeCandidate.detourDistanceKm)}`}</span>
                        )}
                        {distanceFromUserKm !== undefined && (
                          <span>{`Nuo jūsų: ${formatKilometers(distanceFromUserKm)}`}</span>
                        )}
                        <span>{stationStatusLabel}</span>
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  )
}

export default App
