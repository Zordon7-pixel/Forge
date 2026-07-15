import { useEffect, useMemo, useState } from 'react'
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap } from 'react-leaflet'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChevronDown, ChevronUp, LoaderCircle, MapPin, Mountain, Navigation, Route as RouteIcon, Trees } from 'lucide-react'
import api from '../lib/api'
import { useUnits } from '../context/UnitsContext'

const ELEVATION_OPTIONS = [
  { value: 'flat', label: 'Flat', detail: 'Lowest gain' },
  { value: 'balanced', label: 'Rolling', detail: 'Some hills' },
  { value: 'hilly', label: 'Hilly', detail: 'Most gain' },
]

function defaultElevationPreference(workout) {
  const type = String(workout?.rawType || workout?.typeLabel || '').toLowerCase()
  if (type.includes('hill') || type.includes('trail')) return 'hilly'
  if (type.includes('easy') || type.includes('recovery')) return 'flat'
  return 'balanced'
}

function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location is unavailable on this device.'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      }),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          reject(new Error('Allow location access in iPhone Settings to plan a route.'))
          return
        }
        reject(new Error('Forged Hybrid could not get your current location. Try again outside.'))
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
    )
  })
}

function FitRouteBounds({ positions }) {
  const map = useMap()
  useEffect(() => {
    if (positions.length > 1) map.fitBounds(positions, { padding: [18, 18] })
  }, [map, positions])
  return null
}

export default function RoutePlanner({ workout, onStart, title = 'Plan an elevation route', startLabel = 'Start this route', variant = 'default' }) {
  const { units, fmt } = useUnits()
  const [expanded, setExpanded] = useState(false)
  const [surface, setSurface] = useState('road')
  const [elevationPreference, setElevationPreference] = useState(() => defaultElevationPreference(workout))
  const [route, setRoute] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const targetDistanceMiles = Number(workout?.distanceMiles || 0)
  const variantStyle = variant === 'paper' ? {
    '--text-primary': 'var(--ink, #23201A)',
    '--text-muted': 'var(--ink-soft, #5A554B)',
    '--bg-card': 'rgba(255,255,255,0.30)',
    '--bg-base': 'rgba(255,255,255,0.44)',
    '--border-subtle': 'rgba(60,55,45,0.18)',
    '--accent': 'var(--paper-run, #C2410C)',
    '--on-accent': '#FFFFFF',
    '--accent-dim': 'rgba(194,65,12,0.10)',
    '--danger': 'var(--paper-red, #B91C1C)',
    '--danger-dim': 'rgba(185,28,28,0.08)',
    '--warning': '#9A3412',
  } : {}

  const positions = useMemo(() => (
    Array.isArray(route?.coordinates)
      ? route.coordinates
        .filter((point) => Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
        .map((point) => [Number(point[0]), Number(point[1])])
      : []
  ), [route])

  if (targetDistanceMiles <= 0) return null

  const formatElevation = (feet) => {
    if (!Number.isFinite(Number(feet))) return '--'
    if (units === 'metric') return `${Math.round(Number(feet) * 0.3048).toLocaleString()} m`
    return `${Math.round(Number(feet)).toLocaleString()} ft`
  }
  const formatChartDistance = (miles) => units === 'metric'
    ? `${(Number(miles) * 1.60934).toFixed(1)} km`
    : `${Number(miles).toFixed(1)} mi`

  const generateRoute = async () => {
    setLoading(true)
    setError('')
    setRoute(null)
    try {
      const start = await currentPosition()
      const response = await api.post('/routes/generate', {
        ...start,
        distanceMiles: targetDistanceMiles,
        elevationPreference,
        surface,
      }, { timeout: 30000 })
      setRoute(response.data?.route || null)
    } catch (err) {
      console.error('[RoutePlanner] generation failed:', err.message)
      setError(err?.response?.data?.error || err.message || 'Forged Hybrid could not plan this route.')
    } finally {
      setLoading(false)
    }
  }

  const changeElevation = (value) => {
    setElevationPreference(value)
    setRoute(null)
    setError('')
  }

  const changeSurface = (value) => {
    setSurface(value)
    setRoute(null)
    setError('')
  }

  return (
    <section className="mt-4 pt-4" style={{ borderTop: '1px solid var(--border-subtle)', ...variantStyle }}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="pressable w-full flex items-center justify-between py-2"
        style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)' }}
      >
        <span className="flex items-center gap-2 text-sm font-black"><RouteIcon size={18} style={{ color: 'var(--accent)' }} /> {title}</span>
        {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
      </button>

      {expanded && (
        <div className="pt-3">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)' }}>Target course</p>
              <p className="text-lg font-black" style={{ color: 'var(--text-primary)' }}>{fmt.distance(targetDistanceMiles, 1)} loop</p>
            </div>
            <Navigation size={22} style={{ color: 'var(--accent)' }} />
          </div>

          <p className="text-xs font-bold uppercase mb-2" style={{ color: 'var(--text-muted)' }}>Elevation</p>
          <div className="grid grid-cols-3 gap-2 mb-4">
            {ELEVATION_OPTIONS.map((option) => {
              const selected = elevationPreference === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => changeElevation(option.value)}
                  className="pressable py-2 px-1"
                  style={{
                    minHeight: 58,
                    borderRadius: 8,
                    border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    background: selected ? 'var(--accent-dim)' : 'var(--bg-card)',
                    color: selected ? 'var(--accent)' : 'var(--text-primary)',
                  }}
                >
                  <span className="block text-xs font-black">{option.label}</span>
                  <span className="block text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>{option.detail}</span>
                </button>
              )
            })}
          </div>

          <p className="text-xs font-bold uppercase mb-2" style={{ color: 'var(--text-muted)' }}>Surface</p>
          <div className="grid grid-cols-2 gap-2 mb-4">
            {[
              { value: 'road', label: 'Road', Icon: MapPin },
              { value: 'trail', label: 'Trail', Icon: Trees },
            ].map(({ value, label, Icon }) => {
              const selected = surface === value
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => changeSurface(value)}
                  className="pressable flex items-center justify-center gap-2 py-2 text-sm font-bold"
                  style={{
                    borderRadius: 8,
                    border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    background: selected ? 'var(--accent-dim)' : 'var(--bg-card)',
                    color: selected ? 'var(--accent)' : 'var(--text-primary)',
                  }}
                >
                  <Icon size={16} /> {label}
                </button>
              )
            })}
          </div>

          <button
            type="button"
            onClick={generateRoute}
            disabled={loading}
            className="pressable w-full flex items-center justify-center gap-2 py-3 font-black"
            style={{ borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', opacity: loading ? 0.65 : 1 }}
          >
            {loading ? <LoaderCircle size={18} className="animate-spin" /> : <RouteIcon size={18} />}
            {loading ? 'Comparing routes...' : route ? 'Generate another route' : 'Generate route'}
          </button>
          <p className="text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>Forged Hybrid sends your start point and target distance to its route provider. The preview is not added to run history unless you complete the run.</p>

          {error && (
            <div className="mt-3 p-3 text-sm" role="alert" style={{ borderRadius: 8, background: 'var(--danger-dim)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.3)' }}>
              {error}
            </div>
          )}

          {route && positions.length > 1 && (
            <div className="mt-4">
              <div className="grid grid-cols-3 gap-2 mb-3 text-center">
                <div><p className="text-[10px] font-bold uppercase" style={{ color: 'var(--text-muted)' }}>Distance</p><p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>{fmt.distance(route.distanceMiles, 1)}</p></div>
                <div><p className="text-[10px] font-bold uppercase" style={{ color: 'var(--text-muted)' }}>Gain</p><p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>{formatElevation(route.elevationGainFeet)}</p></div>
                <div><p className="text-[10px] font-bold uppercase" style={{ color: 'var(--text-muted)' }}>Profile</p><p className="text-sm font-black capitalize" style={{ color: 'var(--text-primary)' }}>{route.elevationPreference === 'balanced' ? 'Rolling' : route.elevationPreference}</p></div>
              </div>

              <div style={{ height: 240, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
                <MapContainer center={positions[0]} zoom={14} scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
                  <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                  <FitRouteBounds positions={positions} />
                  <Polyline positions={positions} pathOptions={{ color: '#EAB308', weight: 5 }} />
                  <CircleMarker center={positions[0]} radius={6} pathOptions={{ color: '#111111', fillColor: '#EAB308', fillOpacity: 1, weight: 2 }} />
                </MapContainer>
              </div>

              {route.elevationProfile?.length > 1 && (
                <div className="mt-3" style={{ height: 120 }}>
                  <div className="flex items-center gap-2 mb-1"><Mountain size={14} style={{ color: 'var(--accent)' }} /><p className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>Elevation profile</p></div>
                  <ResponsiveContainer width="100%" height="90%">
                    <AreaChart data={route.elevationProfile} margin={{ top: 5, right: 4, left: -18, bottom: 0 }}>
                      <defs><linearGradient id="routeElevationFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#EAB308" stopOpacity={0.55} /><stop offset="100%" stopColor="#EAB308" stopOpacity={0.05} /></linearGradient></defs>
                      <XAxis dataKey="distanceMiles" tick={{ fill: '#9CA3AF', fontSize: 9 }} tickFormatter={formatChartDistance} />
                      <YAxis dataKey="elevationFeet" tick={{ fill: '#9CA3AF', fontSize: 9 }} tickFormatter={(value) => units === 'metric' ? Math.round(Number(value) * 0.3048) : Math.round(Number(value))} domain={['dataMin - 10', 'dataMax + 10']} />
                      <Tooltip formatter={(value) => [formatElevation(value), 'Elevation']} labelFormatter={formatChartDistance} contentStyle={{ background: '#111', border: '1px solid #2A2A2A', borderRadius: 6, fontSize: 11 }} />
                      <Area type="monotone" dataKey="elevationFeet" stroke="#EAB308" strokeWidth={2} fill="url(#routeElevationFill)" isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}

              {route.distanceVariancePercent > 10 && <p className="text-xs mt-2" style={{ color: 'var(--warning)' }}>This loop is {route.distanceVariancePercent}% different from the target distance.</p>}
              <p className="text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>{route.notice}</p>
              <button
                type="button"
                onClick={() => onStart?.(route, surface)}
                disabled={typeof onStart !== 'function'}
                className="pressable w-full mt-3 flex items-center justify-center gap-2 py-3 font-black"
                style={{ borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)' }}
              >
                <Navigation size={18} /> {startLabel}
              </button>
              <p className="text-[10px] text-center mt-2" style={{ color: 'var(--text-muted)' }}>Routing by openrouteservice · Map data by OpenStreetMap</p>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
