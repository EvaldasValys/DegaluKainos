import { divIcon, latLng, latLngBounds } from 'leaflet'
import { useEffect } from 'react'
import {
  MapContainer,
  Marker,
  Popup,
  Polyline,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import type { RoutePoint, RouteResult, StationRecord } from '../../shared/types'

interface RouteMapProps {
  stations: StationRecord[]
  route: RouteResult | null
  activeSelectionId: string | null
  routeStationIds: Set<string>
  topStationId: string | null
  featuredStationId: string | null
  focusedStationId: string | null
  focusTarget: {
    stationId: string
    requestId: number
  } | null
  currentLocation: RoutePoint | null
  routePoints: Array<{
    id: string
    label: string
    point: RoutePoint | null
  }>
  onMapPick: (point: RoutePoint) => void
}

function createMarker(className: string, label: string) {
  return divIcon({
    className: 'map-marker-wrapper',
    html: `<div class="map-marker ${className}">${label}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -12],
  })
}

const stationIcon = createMarker('map-marker--station', '')
const reachableIcon = createMarker('map-marker--reachable', '')
const highlightedStationIcon = createMarker('map-marker--featured', '€')
const currentLocationIcon = createMarker('map-marker--me', 'M')
const startIcon = createMarker('map-marker--start', 'A')
const endIcon = createMarker('map-marker--end', 'B')

function formatPrice(value: number | null) {
  return value === null ? 'N/A' : `${value.toFixed(3)} EUR`
}

function LocationPicker({
  activeSelectionId,
  onMapPick,
}: Pick<RouteMapProps, 'activeSelectionId' | 'onMapPick'>) {
  const map = useMap()

  useMapEvents({
    click(event) {
      if (!activeSelectionId) {
        return
      }

      onMapPick({
        lat: event.latlng.lat,
        lng: event.latlng.lng,
      })
    },
  })

  useEffect(() => {
    map.getContainer().style.cursor = activeSelectionId ? 'crosshair' : ''

    return () => {
      map.getContainer().style.cursor = ''
    }
  }, [activeSelectionId, map])

  return null
}

function FitToContent({
  currentLocation,
  routePoints,
  route,
}: Pick<RouteMapProps, 'currentLocation' | 'routePoints' | 'route'>) {
  const map = useMap()

  useEffect(() => {
    const points = route
      ? route.geometry.map(([lng, lat]) => latLng(lat, lng))
      : [currentLocation, ...routePoints.map((routePoint) => routePoint.point)]
          .filter((point): point is RoutePoint => point !== null)
          .map((point) => latLng(point.lat, point.lng))

    if (points.length === 0) {
      return
    }

    if (points.length === 1) {
      map.flyTo(points[0], Math.max(map.getZoom(), 13), { duration: 0.6 })
      return
    }

    map.fitBounds(latLngBounds(points), { padding: [28, 28] })
  }, [currentLocation, map, route, routePoints])

  return null
}

function FocusOnStation({
  focusTarget,
  stations,
}: Pick<RouteMapProps, 'focusTarget' | 'stations'>) {
  const map = useMap()

  useEffect(() => {
    if (!focusTarget) {
      return
    }

    const station = stations.find(
      (candidate) =>
        candidate.id === focusTarget.stationId && candidate.coordinates !== null,
    )

    if (!station?.coordinates) {
      return
    }

    map.flyTo([station.coordinates.lat, station.coordinates.lng], Math.max(map.getZoom(), 15), {
      duration: 0.8,
    })
  }, [focusTarget, map, stations])

  return null
}

export function RouteMap({
  stations,
  route,
  activeSelectionId,
  routeStationIds,
  topStationId,
  featuredStationId,
  focusedStationId,
  focusTarget,
  currentLocation,
  routePoints,
  onMapPick,
}: RouteMapProps) {
  const routeLine = route?.geometry.map(([lng, lat]) => [lat, lng] as [number, number]) ?? []

  return (
    <div className="map-panel">
      <MapContainer center={[55.2, 23.9]} zoom={7} className="map-canvas" scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <LocationPicker activeSelectionId={activeSelectionId} onMapPick={onMapPick} />
        <FitToContent route={route} currentLocation={currentLocation} routePoints={routePoints} />
        <FocusOnStation focusTarget={focusTarget} stations={stations} />
        {routeLine.length > 0 && (
          <Polyline positions={routeLine} pathOptions={{ color: '#ff6b35', weight: 5 }} />
        )}
        {currentLocation && (
          <Marker position={[currentLocation.lat, currentLocation.lng]} icon={currentLocationIcon} />
        )}
        {routePoints.map((routePoint, index) => {
          if (!routePoint.point) {
            return null
          }

          const icon =
            index === 0
              ? startIcon
              : index === routePoints.length - 1
                ? endIcon
                : createMarker('map-marker--waypoint', routePoint.label)

          return (
            <Marker key={routePoint.id} position={[routePoint.point.lat, routePoint.point.lng]} icon={icon}>
              <Popup>{routePoint.label}</Popup>
            </Marker>
          )
        })}
        {stations
          .filter((station) => station.coordinates !== null)
          .map((station) => {
            const position = [station.coordinates!.lat, station.coordinates!.lng] as [number, number]
            const isHighlightedStation =
              station.id === focusedStationId ||
              station.id === topStationId ||
              station.id === featuredStationId
            const icon =
              isHighlightedStation
                ? highlightedStationIcon
                : routeStationIds.has(station.id)
                  ? reachableIcon
                  : stationIcon

            return (
              <Marker key={station.id} position={position} icon={icon}>
                <Popup>
                  <strong>{station.network}</strong>
                  <br />
                  {station.address}
                  <br />
                  {station.city}
                  <br />
                  {station.id === focusedStationId && (
                    <>
                      <span>Pasirinkta iš sąrašo</span>
                      <br />
                    </>
                  )}
                  {station.id === topStationId && (
                    <>
                      <span>Pirmas rezultatas sąraše</span>
                      <br />
                    </>
                  )}
                  {station.id === featuredStationId && (
                    <>
                      <span>Geriausias pasirinkimas</span>
                      <br />
                    </>
                  )}
                  {`95: ${formatPrice(station.prices.gasoline95)}`}
                  <br />
                  {`D: ${formatPrice(station.prices.diesel)}`}
                  <br />
                  {`SND: ${formatPrice(station.prices.lpg)}`}
                </Popup>
              </Marker>
            )
          })}
      </MapContainer>
    </div>
  )
}
