import { useMemo, useState } from 'react'
import { lineString, point } from '@turf/helpers'
import pointToLineDistance from '@turf/point-to-line-distance'
import {
  FUEL_KEYS,
  FUEL_LABELS,
  type FuelKey,
  type PriceSnapshot,
  type RoutePoint,
  type RouteResult,
  type StationRecord,
} from '../shared/types'
import { RouteMap } from './components/RouteMap'
import { fetchRoute, fetchTodayPrices } from './lib/api'
import './App.css'

type SortKey = 'price-asc' | 'price-desc' | 'network'
type ComparisonMode = 'along-route' | 'cheapest-route'

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

function formatPoint(pointValue: RoutePoint | null) {
  if (!pointValue) {
    return 'Pasirinkite žemėlapyje'
  }

  return `${coordinateFormatter.format(pointValue.lat)}, ${coordinateFormatter.format(pointValue.lng)}`
}

function formatKilometers(distanceKm: number) {
  return `${quantityFormatter.format(distanceKm)} km`
}

function formatLiters(liters: number) {
  return `${quantityFormatter.format(liters)} l`
}

function compareStations(
  left: StationRecord,
  right: StationRecord,
  fuelKey: FuelKey,
  sortBy: SortKey,
  routeStationIds: Set<string>,
) {
  const leftRouteBoost = routeStationIds.has(left.id) ? 0 : 1
  const rightRouteBoost = routeStationIds.has(right.id) ? 0 : 1

  if (leftRouteBoost !== rightRouteBoost) {
    return leftRouteBoost - rightRouteBoost
  }

  if (sortBy === 'network') {
    return `${left.network}-${left.city}-${left.address}`.localeCompare(
      `${right.network}-${right.city}-${right.address}`,
      'lt',
    )
  }

  const leftValue = left.prices[fuelKey]
  const rightValue = right.prices[fuelKey]

  if (leftValue === null && rightValue === null) {
    return left.network.localeCompare(right.network, 'lt')
  }

  if (leftValue === null) {
    return 1
  }

  if (rightValue === null) {
    return -1
  }

  return sortBy === 'price-desc' ? rightValue - leftValue : leftValue - rightValue
}

function calculateRouteCandidate(
  station: StationRecord,
  routeLine: RouteResult['geometry'],
  fuelKey: FuelKey,
  purchaseLiters: number,
  fuelConsumptionPer100Km: number,
) {
  if (!station.coordinates) {
    return null
  }

  const corridor = lineString(routeLine)
  const stationPoint = point([station.coordinates.lng, station.coordinates.lat])
  const distanceFromRouteKm = pointToLineDistance(stationPoint, corridor, {
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
  const [sortBy, setSortBy] = useState<SortKey>('price-asc')
  const [selectionMode, setSelectionMode] = useState<'start' | 'end'>('start')
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>('along-route')
  const [startPoint, setStartPoint] = useState<RoutePoint | null>(null)
  const [endPoint, setEndPoint] = useState<RoutePoint | null>(null)
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [routeError, setRouteError] = useState<string | null>(null)
  const [isLoadingRoute, setIsLoadingRoute] = useState(false)
  const [corridorKm, setCorridorKm] = useState(2.5)
  const [plannedFuelLiters, setPlannedFuelLiters] = useState(40)
  const [fuelConsumptionPer100Km, setFuelConsumptionPer100Km] = useState(7)

  const networks = useMemo(() => {
    const values = new Set((snapshot?.stations ?? []).map((station) => station.network))
    return Array.from(values).sort((left, right) => left.localeCompare(right, 'lt'))
  }, [snapshot])

  const municipalities = useMemo(() => {
    const values = new Set((snapshot?.stations ?? []).map((station) => station.municipality))
    return Array.from(values).sort((left, right) => left.localeCompare(right, 'lt'))
  }, [snapshot])

  const filteredStations = useMemo(() => {
    const query = areaQuery.trim().toLowerCase()

    return (snapshot?.stations ?? []).filter((station) => {
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
  }, [areaQuery, municipalityFilter, networkFilter, snapshot])

  const routeCandidates = useMemo(() => {
    if (!route) {
      return [] as RouteCandidate[]
    }

    return filteredStations
      .map((station) =>
        calculateRouteCandidate(
          station,
          route.geometry,
          fuelKey,
          Math.max(plannedFuelLiters, 0),
          Math.max(fuelConsumptionPer100Km, 0),
        ),
      )
      .filter((candidate): candidate is RouteCandidate => candidate !== null)
      .filter((candidate) => candidate.distanceFromRouteKm <= corridorKm)
  }, [corridorKm, filteredStations, fuelConsumptionPer100Km, fuelKey, plannedFuelLiters, route])

  const routeStationIds = useMemo(
    () => new Set(routeCandidates.map((candidate) => candidate.station.id)),
    [routeCandidates],
  )

  const routeCandidateMap = useMemo(
    () => new Map(routeCandidates.map((candidate) => [candidate.station.id, candidate])),
    [routeCandidates],
  )

  const bestRouteCandidate = useMemo(() => {
    const comparableCandidates = routeCandidates.filter(
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
  }, [routeCandidates])

  const sortedFilteredStations = useMemo(
    () =>
      [...filteredStations].sort((left, right) =>
        compareStations(left, right, fuelKey, sortBy, routeStationIds),
      ),
    [filteredStations, fuelKey, routeStationIds, sortBy],
  )

  const sortedRouteStations = useMemo(
    () =>
      routeCandidates
        .map((candidate) => candidate.station)
        .sort((left, right) => compareStations(left, right, fuelKey, sortBy, routeStationIds)),
    [fuelKey, routeCandidates, routeStationIds, sortBy],
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

  const featuredStationId = bestRouteCandidate?.station.id ?? null
  const mappedStations = filteredStations.filter((station) => station.coordinates !== null).length

  async function handleFetchSnapshot() {
    setIsLoadingSnapshot(true)
    setSnapshotError(null)

    try {
      const nextSnapshot = await fetchTodayPrices()
      setSnapshot(nextSnapshot)
    } catch (error) {
      setSnapshotError(error instanceof Error ? error.message : 'Nepavyko gauti šiandienos kainų.')
    } finally {
      setIsLoadingSnapshot(false)
    }
  }

  async function handleFetchRoute() {
    if (!startPoint || !endPoint) {
      setRouteError('Pirmiausia pasirinkite abu taškus A ir B žemėlapyje.')
      return
    }

    setIsLoadingRoute(true)
    setRouteError(null)

    try {
      const nextRoute = await fetchRoute(startPoint, endPoint)
      setRoute(nextRoute)
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : 'Nepavyko apskaičiuoti maršruto.')
    } finally {
      setIsLoadingRoute(false)
    }
  }

  function handleMapPick(pointValue: RoutePoint) {
    if (selectionMode === 'start') {
      setStartPoint(pointValue)
      setSelectionMode('end')
      return
    }

    setEndPoint(pointValue)
  }

  function handleClearRoute() {
    setRoute(null)
    setRouteError(null)
    setStartPoint(null)
    setEndPoint(null)
    setSelectionMode('start')
  }

  const routeResultLabel =
    comparisonMode === 'cheapest-route'
      ? 'Pigiausias sustojimas maršrute'
      : 'Stotelės palei maršrutą'

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Lietuvos degalų palyginimas</p>
          <h1>Dienos kainos + maršruto režimai tarp A ir B</h1>
          <p className="hero-copy">
            Atnaujinkite šiandienos ENA Excel duomenis, filtruokite stoteles ir pasirinkite, ar
            norite matyti visas degalines palei maršrutą, ar vieną pigiausią sustojimą pagal kainą
            ir numatomą papildomą atstumą.
          </p>
        </div>
        <div className="hero-actions">
          <button
            type="button"
            className="primary-button"
            onClick={handleFetchSnapshot}
            disabled={isLoadingSnapshot}
          >
            {isLoadingSnapshot ? 'Kraunama...' : 'Gauti šiandienos kainas'}
          </button>
          {snapshot && (
            <div className="source-meta">
              <span>{`Data: ${snapshot.snapshotDate}`}</span>
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
          Paspauskite mygtuką, kad serveris parsiųstų šiandienos ENA Excel failą.
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
                {networks.map((network) => (
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
              </select>
            </label>
          </section>

          <section className="panel">
            <h2>Maršrutas ir palyginimas</h2>
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
            <div className="point-summary">
              <div>
                <span>Taškas A</span>
                <strong>{formatPoint(startPoint)}</strong>
              </div>
              <div>
                <span>Taškas B</span>
                <strong>{formatPoint(endPoint)}</strong>
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
            <div className="field-grid">
              <label className="field">
                <span>Planuojamas pirkimas (litrai)</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={plannedFuelLiters}
                  onChange={(event) =>
                    setPlannedFuelLiters(Math.max(Number(event.target.value) || 0, 1))
                  }
                />
              </label>
              <label className="field">
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
              numanomą papildomą kelią iki stotelės ir atgal į maršrutą.
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

          <section className="panel">
            <h2>Aprėptis</h2>
            <ul className="coverage-list">
              <li>{`Koordinatės iš talpyklos: ${snapshot?.coverage.cacheMatches ?? 0}`}</li>
              <li>{`Sutapatinta su OpenStreetMap stotelėmis: ${snapshot?.coverage.osmMatches ?? 0}`}</li>
              <li>{`Papildomai geokoduota: ${snapshot?.coverage.geocoderMatches ?? 0}`}</li>
              <li>{`Matomų stotelių žemėlapyje: ${mappedStations}`}</li>
            </ul>
          </section>
        </aside>

        <main className="main-column">
          <RouteMap
            stations={sortedFilteredStations}
            route={route}
            activeSelection={selectionMode}
            routeStationIds={routeStationIds}
            featuredStationId={comparisonMode === 'cheapest-route' ? featuredStationId : null}
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
                  <strong>{routeCandidates.length}</strong>
                  <span>maršruto kandidatų</span>
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
                      const isBestStation = station.id === featuredStationId
                      const routeCandidate = routeCandidateMap.get(station.id)

                      return (
                        <tr
                          key={station.id}
                          className={[
                            'station-row',
                            isOnRoute ? 'station-row--highlight' : '',
                            isBestStation ? 'station-row--best' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          <td>
                            <strong>{station.network}</strong>
                            <div className="address-text">{station.address}</div>
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
                            {isBestStation ? (
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
