import { useEffect, useMemo } from 'react'
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap } from 'react-leaflet'

function FitBounds({ positions }) {
  const map = useMap()
  useEffect(() => {
    if (positions.length > 1) map.fitBounds(positions, { padding: [18, 18] })
  }, [map, positions])
  return null
}

export default function RoutePreviewMap({ route, height = 220 }) {
  const positions = useMemo(() => (
    Array.isArray(route?.coordinates)
      ? route.coordinates
        .filter((point) => Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
        .map((point) => [Number(point[0]), Number(point[1])])
      : []
  ), [route])

  if (positions.length < 2) return null

  return (
    <div style={{ height, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
      <MapContainer center={positions[0]} zoom={14} scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
        <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <FitBounds positions={positions} />
        <Polyline positions={positions} pathOptions={{ color: '#EAB308', weight: 5 }} />
        <CircleMarker center={positions[0]} radius={6} pathOptions={{ color: '#111111', fillColor: '#EAB308', fillOpacity: 1, weight: 2 }} />
      </MapContainer>
    </div>
  )
}
