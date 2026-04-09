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
  activeSelection: 'start' | 'end'
  routeStationIds: Set<string>
  featuredStationId: string | null
  startPoint: RoutePoint | null
  endPoint: RoutePoint | null
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
const featuredIcon = createMarker('map-marker--featured', '€')
const startIcon = createMarker('map-marker--start', 'A')
const endIcon = createMarker('map-marker--end', 'B')

function formatPrice(value: number | null) {
  return value === null ? 'N/A' : `${value.toFixed(3)} EUR`
}

function LocationPicker({
  activeSelection,
  onMapPick,
}: Pick<RouteMapProps, 'activeSelection' | 'onMapPick'>) {
  useMapEvents({
    click(event) {
      onMapPick({
        lat: event.latlng.lat,
        lng: event.latlng.lng,
      })
    },
  })

  useEffect(() => {
    document.body.style.cursor = activeSelection === 'start' ? 'crosshair' : 'copy'

    return () => {
      document.body.style.cursor = 'default'
    }
  }, [activeSelection])

  return null
}

function FitToContent({
  startPoint,
  endPoint,
  route,
}: Pick<RouteMapProps, 'startPoint' | 'endPoint' | 'route'>) {
  const map = useMap()

  useEffect(() => {
    const points = route
      ? route.geometry.map(([lng, lat]) => latLng(lat, lng))
      : [startPoint, endPoint]
          .filter((point): point is RoutePoint => point !== null)
          .map((point) => latLng(point.lat, point.lng))

    if (points.length < 2) {
      return
    }

    map.fitBounds(latLngBounds(points), { padding: [28, 28] })
  }, [map, route, startPoint, endPoint])

  return null
}

export function RouteMap({
  stations,
  route,
  activeSelection,
  routeStationIds,
  featuredStationId,
  startPoint,
  endPoint,
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
        <LocationPicker activeSelection={activeSelection} onMapPick={onMapPick} />
        <FitToContent route={route} startPoint={startPoint} endPoint={endPoint} />
        {routeLine.length > 0 && (
          <Polyline positions={routeLine} pathOptions={{ color: '#ff6b35', weight: 5 }} />
        )}
        {startPoint && <Marker position={[startPoint.lat, startPoint.lng]} icon={startIcon} />}
        {endPoint && <Marker position={[endPoint.lat, endPoint.lng]} icon={endIcon} />}
        {stations
          .filter((station) => station.coordinates !== null)
          .map((station) => {
            const position = [station.coordinates!.lat, station.coordinates!.lng] as [number, number]
            const icon =
              station.id === featuredStationId
                ? featuredIcon
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
