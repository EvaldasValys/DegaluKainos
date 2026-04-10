import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { lineString, point } from '@turf/helpers'
import pointToLineDistance from '@turf/point-to-line-distance'
import {
  type AddressSuggestion,
  FUEL_KEYS,
  FUEL_LABELS,
  type FuelKey,
  type PriceSnapshot,
  type RoutePoint,
  type RouteResult,
  type StationRecord,
} from '../shared/types'
import { RouteMap } from './components/RouteMap'
import {
  fetchAddressPoint,
  fetchAddressSuggestions,
  fetchLatestPricesWithOptions,
  fetchRoute,
} from './lib/api'
import './App.css'

type SortKey = 'price-asc' | 'price-desc' | 'network' | 'detour-asc' | 'total-cost-asc'
type ComparisonMode = 'along-route' | 'cheapest-route'
type ListVisibility = 'all' | 'priced' | 'mapped' | 'route'
type PointInputMode = 'map' | 'address'
type AddressFieldKey = 'start' | 'end'

const AUTOCOMPLETE_MIN_QUERY_LENGTH = 3
const AUTOCOMPLETE_DEBOUNCE_MS = 250
const SNAPSHOT_REFRESH_DEBOUNCE_MS = 5000
const DEFAULT_BLACKLIST = ['Jozita']

interface RouteCandidate {
  station: StationRecord
  distanceFromRouteKm: number
  estimatedDetourKm: number
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

function formatLiters(liters: number) {
  return `${quantityFormatter.format(liters)} l`
}

function formatDateTime(value: string) {
  const parsedDate = new Date(value)

  if (Number.isNaN(parsedDate.getTime())) {
    return value
  }

  return dateTimeFormatter.format(parsedDate)
}

function normalizeNetworkName(value: string) {
  return value.trim().toLowerCase()
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
  sortBy: SortKey,
  routeCandidateMap: Map<string, RouteCandidate>,
) {
  if (sortBy === 'network') {
    return compareStationNames(left, right)
  }

  if (sortBy === 'detour-asc') {
    return (
      compareNullableNumbers(
        routeCandidateMap.get(left.id)?.estimatedDetourKm ?? null,
        routeCandidateMap.get(right.id)?.estimatedDetourKm ?? null,
      ) || compareStationNames(left, right)
    )
  }

  if (sortBy === 'total-cost-asc') {
    return (
      compareNullableNumbers(
        routeCandidateMap.get(left.id)?.totalEstimatedCost ?? null,
        routeCandidateMap.get(right.id)?.totalEstimatedCost ?? null,
      ) ||
      compareNullableNumbers(
        routeCandidateMap.get(left.id)?.estimatedDetourKm ?? null,
        routeCandidateMap.get(right.id)?.estimatedDetourKm ?? null,
      ) ||
      compareStationNames(left, right)
    )
  }

  const leftValue = left.prices[fuelKey]
  const rightValue = right.prices[fuelKey]

  if (leftValue === null && rightValue === null) {
    return compareStationNames(left, right)
  }

  return (
    compareNullableNumbers(leftValue, rightValue, sortBy === 'price-desc' ? 'desc' : 'asc') ||
    compareStationNames(left, right)
  )
}

function calculateRouteCandidate(
  station: StationRecord,
  routeCorridor: ReturnType<typeof lineString>,
  fuelKey: FuelKey,
  purchaseLiters: number,
  fuelConsumptionPer100Km: number,
) {
  if (!station.coordinates) {
    return null
  }

  const stationPoint = point([station.coordinates.lng, station.coordinates.lat])
  const distanceFromRouteKm = pointToLineDistance(stationPoint, routeCorridor, {
    units: 'kilometers',
  })
  const estimatedDetourKm = distanceFromRouteKm * 2
  const fuelPrice = station.prices[fuelKey]
  const detourFuelLiters = (estimatedDetourKm * fuelConsumptionPer100Km) / 100
  const purchaseCost = fuelPrice === null ? null : purchaseLiters * fuelPrice
  const detourFuelCost = fuelPrice === null ? null : detourFuelLiters * fuelPrice
  const totalEstimatedCost =
    purchaseCost === null || detourFuelCost === null ? null : purchaseCost + detourFuelCost

  return {
    station,
    distanceFromRouteKm,
    estimatedDetourKm,
    fuelPrice,
    purchaseLiters,
    purchaseCost,
    detourFuelLiters,
    detourFuelCost,
    totalEstimatedCost,
  } satisfies RouteCandidate
}

function App() {
  const [snapshot, setSnapshot] = useState<PriceSnapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [isLoadingSnapshot, setIsLoadingSnapshot] = useState(false)
  const [fuelKey, setFuelKey] = useState<FuelKey>('gasoline95')
  const [networkFilter, setNetworkFilter] = useState('all')
  const [municipalityFilter, setMunicipalityFilter] = useState('all')
  const [areaQuery, setAreaQuery] = useState('')
  const [listVisibility, setListVisibility] = useState<ListVisibility>('all')
  const [sortBy, setSortBy] = useState<SortKey>('price-asc')
  const [selectionMode, setSelectionMode] = useState<'start' | 'end'>('start')
  const [pointInputMode, setPointInputMode] = useState<PointInputMode>('map')
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>('along-route')
  const [startPoint, setStartPoint] = useState<RoutePoint | null>(null)
  const [endPoint, setEndPoint] = useState<RoutePoint | null>(null)
  const [startAddress, setStartAddress] = useState('')
  const [endAddress, setEndAddress] = useState('')
  const [blacklistedNetworks, setBlacklistedNetworks] = useState<string[]>(DEFAULT_BLACKLIST)
  const [blacklistInput, setBlacklistInput] = useState('')
  const [activeAddressField, setActiveAddressField] = useState<AddressFieldKey | null>(null)
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [routeError, setRouteError] = useState<string | null>(null)
  const [isLoadingRoute, setIsLoadingRoute] = useState(false)
  const [isSnapshotRefreshCoolingDown, setIsSnapshotRefreshCoolingDown] = useState(false)
  const [focusedStationId, setFocusedStationId] = useState<string | null>(null)
  const [mapFocusTarget, setMapFocusTarget] = useState<MapFocusTarget | null>(null)
  const [corridorKm, setCorridorKm] = useState(2.5)
  const [plannedFuelLiters, setPlannedFuelLiters] = useState(40)
  const [fuelConsumptionPer100Km, setFuelConsumptionPer100Km] = useState(7)
  const snapshotRefreshCooldownTimerRef = useRef<number | null>(null)

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
    const query = areaQuery.trim().toLowerCase()

    return (snapshot?.stations ?? []).filter((station) => {
      if (blacklistedNetworkKeys.has(normalizeNetworkName(station.network))) {
        return false
      }

      if (networkFilter !== 'all' && station.network !== networkFilter) {
        return false
      }

      if (municipalityFilter !== 'all' && station.municipality !== municipalityFilter) {
        return false
      }

      if (query.length > 0 && !station.searchableText.includes(query)) {
        return false
      }

      return true
    })
  }, [areaQuery, blacklistedNetworkKeys, municipalityFilter, networkFilter, snapshot])

  const allRouteCandidates = useMemo(() => {
    if (!route) {
      return [] as RouteCandidate[]
    }

    const routeCorridor = lineString(route.geometry)

    return filteredStations
      .map((station) =>
        calculateRouteCandidate(
          station,
          routeCorridor,
          fuelKey,
          Math.max(plannedFuelLiters, 0),
          Math.max(fuelConsumptionPer100Km, 0),
        ),
      )
      .filter((candidate): candidate is RouteCandidate => candidate !== null)
  }, [filteredStations, fuelConsumptionPer100Km, fuelKey, plannedFuelLiters, route])

  const routeCandidates = useMemo(
    () => allRouteCandidates.filter((candidate) => candidate.distanceFromRouteKm <= corridorKm),
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
        candidate.estimatedDetourKm < bestCandidate.estimatedDetourKm
      ) {
        return candidate
      }

      return bestCandidate
    }, null as RouteCandidate | null)
  }, [routeVisibleCandidates])

  const sortedFilteredStations = useMemo(
    () =>
      [...listVisibleStations].sort((left, right) =>
        compareStations(left, right, fuelKey, sortBy, routeCandidateMap),
      ),
    [fuelKey, listVisibleStations, routeCandidateMap, sortBy],
  )

  const sortedRouteStations = useMemo(
    () =>
      routeVisibleCandidates
        .map((candidate) => candidate.station)
        .sort((left, right) => compareStations(left, right, fuelKey, sortBy, routeCandidateMap)),
    [fuelKey, routeCandidateMap, routeVisibleCandidates, sortBy],
  )

  const displayedStations = useMemo(() => {
    if (!route) {
      return sortedFilteredStations
    }

    if (comparisonMode === 'cheapest-route') {
      return bestRouteCandidate ? [bestRouteCandidate.station] : []
    }

    return sortedRouteStations
  }, [bestRouteCandidate, comparisonMode, route, sortedFilteredStations, sortedRouteStations])

  const topStationId = displayedStations.at(0)?.id ?? null
  const activePointSelectionMode = pointInputMode === 'map' ? selectionMode : 'none'
  const emptyPointLabel =
    pointInputMode === 'map' ? 'Pasirinkite žemėlapyje' : 'Įveskite adresą'
  const featuredStationId = bestRouteCandidate?.station.id ?? null
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

  useEffect(() => {
    if (networkFilter !== 'all' && blacklistedNetworkKeys.has(normalizeNetworkName(networkFilter))) {
      setNetworkFilter('all')
    }
  }, [blacklistedNetworkKeys, networkFilter])

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
    setIsLoadingRoute(true)
    setRouteError(null)

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
      setRoute(nextRoute)
    } catch (error) {
      setRouteError(
        error instanceof Error
          ? error.message
          : 'Nepavyko apskaičiuoti maršruto pagal pasirinktus taškus.',
      )
    } finally {
      setIsLoadingRoute(false)
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
    setRoute(null)
    setRouteError(null)
    setFocusedStationId(null)
    setMapFocusTarget(null)
    setStartPoint(null)
    setEndPoint(null)
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

  const routeResultLabel =
    comparisonMode === 'cheapest-route'
      ? 'Pigiausias sustojimas maršrute'
      : 'Stotelės palei maršrutą'

  const routePanel = (
    <section className="panel">
      <h2>Maršrutas ir palyginimas</h2>
      <div className="toggle-group">
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
      </div>
      <div className="toggle-group">
        <button
          type="button"
          className={
            comparisonMode === 'along-route'
              ? 'toggle-button toggle-button--active'
              : 'toggle-button'
          }
          onClick={() => setComparisonMode('along-route')}
        >
          Visos stotelės palei maršrutą
        </button>
        <button
          type="button"
          className={
            comparisonMode === 'cheapest-route'
              ? 'toggle-button toggle-button--active'
              : 'toggle-button'
          }
          onClick={() => setComparisonMode('cheapest-route')}
        >
          Pigiausias sustojimas
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
      <div className="point-summary">
        <div>
          <span>Taškas A</span>
          <strong>{formatPoint(startPoint, emptyPointLabel)}</strong>
        </div>
        <div>
          <span>Taškas B</span>
          <strong>{formatPoint(endPoint, emptyPointLabel)}</strong>
        </div>
      </div>
      <label className="field">
        <span>{`Maksimalus nuokrypis nuo maršruto: ${corridorKm.toFixed(1)} km`}</span>
        <input
          type="range"
          min="0.5"
          max="10"
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
            value={plannedFuelLiters}
            onChange={(event) => setPlannedFuelLiters(Math.max(Number(event.target.value) || 0, 1))}
          />
        </label>
        <label className="field field--compact">
          <span>Sąnaudos l/100 km</span>
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={fuelConsumptionPer100Km}
            onChange={(event) =>
              setFuelConsumptionPer100Km(Math.max(Number(event.target.value) || 0, 0.1))
            }
          />
        </label>
      </div>
      <p className="panel-note">
        Pigiausias sustojimas skaičiuojamas pagal pasirinktą kuro rūšį, planuojamą litražą ir
        numanomą papildomą kelią iki stotelės ir atgal į maršrutą. Taškus galite pasirinkti
        žemėlapyje arba įvesti adresais su automatiniais pasiūlymais.
      </p>
      <div className="route-actions">
        <button
          type="button"
          className="primary-button"
          onClick={handleFetchRoute}
          disabled={isLoadingRoute || filteredStations.length === 0}
        >
          {isLoadingRoute ? 'Skaičiuojama...' : 'Rasti degalines palei maršrutą'}
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
      {routeError && <p className="route-error">{routeError}</p>}
      {route && comparisonMode === 'cheapest-route' && bestRouteCandidate && (
        <div className="result-card">
          <div className="result-card__header">
            <div>
              <span className="summary-label">Pigiausias sustojimas</span>
              <strong>{bestRouteCandidate.station.network}</strong>
            </div>
            <span className="route-pill route-pill--best">Geriausias pasirinkimas</span>
          </div>
          <p className="address-text">{bestRouteCandidate.station.address}</p>
          <div className="metric-grid">
            <div className="metric-card">
              <span className="metric-label">Kaina už litrą</span>
              <strong>{formatFuelPrice(bestRouteCandidate.fuelPrice)}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Pirkimo kaina</span>
              <strong>{formatMoney(bestRouteCandidate.purchaseCost)}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Papildomas kelias</span>
              <strong>{formatKilometers(bestRouteCandidate.estimatedDetourKm)}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Papildomos sąnaudos</span>
              <strong>{formatLiters(bestRouteCandidate.detourFuelLiters)}</strong>
            </div>
            <div className="metric-card metric-card--wide">
              <span className="metric-label">Numatoma bendra sustojimo kaina</span>
              <strong>{formatMoney(bestRouteCandidate.totalEstimatedCost)}</strong>
            </div>
          </div>
        </div>
      )}
      {route && comparisonMode === 'cheapest-route' && !bestRouteCandidate && (
        <p className="panel-note">
          Šiuo metu palei pasirinktą maršrutą nėra stotelių su žinoma pasirinkto kuro kaina.
        </p>
      )}
    </section>
  )

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Lietuvos degalų palyginimas</p>
          <h1>Dienos kainos + maršruto režimai tarp A ir B</h1>
          <p className="hero-copy">
            Naudokite paskelbtus ENA duomenis, filtruokite stoteles ir pasirinkite, ar norite
            matyti visas degalines palei maršrutą, ar vieną pigiausią sustojimą pagal kainą ir
            numatomą papildomą atstumą.
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
          {snapshot && (
            <div className="source-meta">
              <span>{`Data: ${snapshot.snapshotDate}`}</span>
              <span>{`Paskelbta: ${formatDateTime(snapshot.fetchedAt)}`}</span>
              <a href={snapshot.sourceUrl} target="_blank" rel="noreferrer">
                Excel šaltinis
              </a>
            </div>
          )}
        </div>
      </header>

      <section className="summary-grid">
        <article className="summary-card">
          <span className="summary-label">Stotelių šiandien</span>
          <strong>{snapshot?.coverage.totalStations ?? 0}</strong>
        </article>
        <article className="summary-card">
          <span className="summary-label">Su koordinatėmis</span>
          <strong>{snapshot?.coverage.locatedStations ?? 0}</strong>
        </article>
        <article className="summary-card">
          <span className="summary-label">Rodoma po filtrų</span>
          <strong>{filteredStations.length}</strong>
        </article>
        <article className="summary-card">
          <span className="summary-label">{routeResultLabel}</span>
          <strong>{route ? displayedStations.length : 0}</strong>
        </article>
      </section>

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
            <h2>Filtrai ir rikiavimas</h2>
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
              <select
                value={networkFilter}
                onChange={(event) => setNetworkFilter(event.target.value)}
              >
                <option value="all">Visi tinklai</option>
                {selectableNetworks.map((network) => (
                  <option key={network} value={network}>
                    {network}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Savivaldybė</span>
              <select
                value={municipalityFilter}
                onChange={(event) => setMunicipalityFilter(event.target.value)}
              >
                <option value="all">Visa Lietuva</option>
                {municipalities.map((municipality) => (
                  <option key={municipality} value={municipality}>
                    {municipality}
                  </option>
                ))}
              </select>
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
            <label className="field">
              <span>Miestas / gatvė / paieška</span>
              <input
                type="search"
                value={areaQuery}
                onChange={(event) => setAreaQuery(event.target.value)}
                placeholder="Pvz. Vilnius, Kaunas, Kalvarijų"
              />
            </label>
            <label className="field">
              <span>Rikiuoti</span>
              <select value={sortBy} onChange={(event) => setSortBy(event.target.value as SortKey)}>
                <option value="price-asc">Pigiausia viršuje</option>
                <option value="price-desc">Brangiausia viršuje</option>
                <option value="network">Pagal tinklą / adresą</option>
                <option value="detour-asc">Trumpiausias papildomas kelias</option>
                <option value="total-cost-asc">Mažiausia numatoma sustojimo kaina</option>
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
            route={route}
            activeSelection={activePointSelectionMode}
            routeStationIds={routeStationIds}
            topStationId={topStationId}
            featuredStationId={comparisonMode === 'cheapest-route' ? featuredStationId : null}
            focusedStationId={focusedStationId}
            focusTarget={mapFocusTarget}
            startPoint={startPoint}
            endPoint={endPoint}
            onMapPick={handleMapPick}
          />

          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>{`Stotelių sąrašas (${displayedStations.length})`}</h2>
                <p className="panel-note">
                  Aktyvus kainos stulpelis: <strong>{FUEL_LABELS[fuelKey]}</strong>
                </p>
              </div>
              {route && (
                <div className="route-chip">
                  <strong>{routeVisibleCandidates.length}</strong>
                  <span>matomų maršruto kandidatų</span>
                </div>
              )}
            </div>

            {displayedStations.length === 0 ? (
              <p className="empty-state">
                {route && comparisonMode === 'cheapest-route'
                  ? 'Neradome maršruto stotelių, kurias būtų galima palyginti pagal kainą ir atstumą.'
                  : 'Kol kas nėra rodomų stotelių pagal pasirinktus filtrus.'}
              </p>
            ) : (
              <div className="table-wrap">
                <table className="stations-table">
                  <thead>
                    <tr>
                      <th>Degalinė</th>
                      <th>Vieta</th>
                      <th>95</th>
                      <th>Dyzelinas</th>
                      <th>SND</th>
                      <th>Nuokrypis</th>
                      <th>Numatoma kaina</th>
                      <th>Maršrutas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedStations.map((station) => {
                      const isOnRoute = routeStationIds.has(station.id)
                      const isTopStation = station.id === topStationId
                      const isBestStation = station.id === featuredStationId
                      const isFocusedStation = station.id === focusedStationId
                      const routeCandidate = routeCandidateMap.get(station.id)
                      const canFocusOnMap = station.coordinates !== null

                      return (
                        <tr
                          key={station.id}
                          className={[
                            'station-row',
                            isTopStation ? 'station-row--top' : '',
                            isOnRoute ? 'station-row--highlight' : '',
                            isBestStation ? 'station-row--best' : '',
                            isFocusedStation ? 'station-row--focused' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          <td>
                            <button
                              type="button"
                              className="station-focus-button"
                              onClick={() => handleFocusStation(station)}
                              disabled={!canFocusOnMap}
                            >
                              <strong>{station.network}</strong>
                              <div className="address-text">{station.address}</div>
                            </button>
                          </td>
                          <td>
                            <span>{station.city}</span>
                            <div className="address-text">{station.municipality}</div>
                          </td>
                          <td>{formatFuelPrice(station.prices.gasoline95)}</td>
                          <td>{formatFuelPrice(station.prices.diesel)}</td>
                          <td>{formatFuelPrice(station.prices.lpg)}</td>
                          <td className={routeCandidate ? 'table-number' : 'table-number table-number--muted'}>
                            {routeCandidate
                              ? formatKilometers(routeCandidate.estimatedDetourKm)
                              : '—'}
                          </td>
                          <td className={routeCandidate ? 'table-number' : 'table-number table-number--muted'}>
                            {routeCandidate
                              ? formatMoney(routeCandidate.totalEstimatedCost)
                              : '—'}
                          </td>
                          <td>
                            {isFocusedStation ? (
                              <span className="route-pill route-pill--focus">Žiūrima žemėlapyje</span>
                            ) : isTopStation ? (
                              <span className="route-pill route-pill--top">Pirmas sąraše</span>
                            ) : isBestStation ? (
                              <span className="route-pill route-pill--best">Pigiausia</span>
                            ) : isOnRoute ? (
                              <span className="route-pill route-pill--on">Pakeliui</span>
                            ) : station.coordinates ? (
                              <span className="route-pill">Žemėlapyje</span>
                            ) : (
                              <span className="route-pill">Be koord.</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  )
}

export default App
