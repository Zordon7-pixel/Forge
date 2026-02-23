import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { MapContainer, Marker, Polyline, TileLayer } from 'react-leaflet'
import L from 'leaflet'
import api from '../lib/api'
import PostRunCheckIn from '../components/PostRunCheckIn'

function haversineMiles(a, b) {
  const R = 3958.8
  const toRad = d => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)

  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

export default function ActiveRun() {
  const location = useLocation()
  const navigate = useNavigate()
  const selectedCountdown = location?.state?.countdown ?? 3
  const [countdownVal, setCountdownVal] = useState(selectedCountdown)
  const [countingDown, setCountingDown] = useState(selectedCountdown > 0)
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [distanceMiles, setDistanceMiles] = useState(0)
  const [gpsError, setGpsError] = useState('')
  const [saving, setSaving] = useState(false)
  const [showPostCheckIn, setShowPostCheckIn] = useState(false)
  const [savedRunId, setSavedRunId] = useState(null)
  const [mapMyRun, setMapMyRun] = useState(false)
  const [routeCoords, setRouteCoords] = useState([])
  const watchRef = useRef(null)
  const lastPointRef = useRef(null)

  const startGPS = () => {
    if (!navigator?.geolocation) {
      setGpsError('Geolocation is not supported on this device/browser.')
      return
    }

    setRunning(true)
    watchRef.current = navigator.geolocation.watchPosition(
      pos => {
        const point = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude
        }
        if (lastPointRef.current) {
          const segment = haversineMiles(lastPointRef.current, point)
          if (segment > 0 && segment < 0.25) setDistanceMiles(v => v + segment)
        }
        if (mapMyRun) setRouteCoords((prev) => [...prev, [point.lat, point.lon]])
        lastPointRef.current = point
      },
      err => {
        setGpsError(err?.message || 'Unable to access GPS.')
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 }
    )
  }

  useEffect(() => {
    if (!countingDown) return
    if (countdownVal <= 0) {
      setCountingDown(false)
      startGPS()
      return
    }
    const t = setTimeout(() => setCountdownVal(v => v - 1), 1000)
    return () => clearTimeout(t)
  }, [countingDown, countdownVal])

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setElapsed(v => v + 1), 1000)
    return () => clearInterval(t)
  }, [running])

  useEffect(() => {
    return () => {
      if (watchRef.current != null && navigator?.geolocation) {
        navigator.geolocation.clearWatch(watchRef.current)
      }
    }
  }, [])

  const pace = useMemo(() => {
    if (!distanceMiles || !elapsed) return '--'
    const p = elapsed / 60 / distanceMiles
    const m = Math.floor(p)
    const s = Math.round((p - m) * 60)
    return `${m}:${String(s).padStart(2, '0')} /mi`
  }, [distanceMiles, elapsed])

  const timeDisplay = useMemo(() => {
    const h = Math.floor(elapsed / 3600)
    const m = Math.floor((elapsed % 3600) / 60)
    const s = elapsed % 60
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${m}:${String(s).padStart(2, '0')}`
  }, [elapsed])

  const saveRun = async () => {
    setSaving(true)
    try {
      const res = await api.post('/runs', {
        date: new Date().toISOString().slice(0, 10),
        type: 'easy',
        run_surface: 'outdoor',
        distance_miles: distanceMiles,
        duration_seconds: elapsed,
        notes: '',
        perceived_effort: 5,
        route_coords: routeCoords.map(([lat, lon]) => ({ lat, lon }))
      })
      const runId = res.data?.id || res.data?.run?.id
      if (runId) {
        setSavedRunId(runId)
        setShowPostCheckIn(true)
      }
    } catch (err) {
      console.error('Failed to save run:', err)
    } finally {
      setSaving(false)
    }
  }

  const finishRun = () => {
    setRunning(false)
    if (watchRef.current != null && navigator?.geolocation) {
      navigator.geolocation.clearWatch(watchRef.current)
    }
    saveRun()
  }

  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
      {countingDown && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: '#000' }}>
          <div className="text-center">
            <p className="text-9xl font-black" style={{ color: 'var(--accent)' }}>{countdownVal}</p>
            <p className="text-xl mt-4" style={{ color: 'var(--text-muted)' }}>Get ready...</p>
          </div>
        </div>
      )}

      <h2 className="text-2xl font-black mb-4" style={{ color: 'var(--text-primary)' }}>Active Run</h2>

      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="rounded-xl p-3 text-center" style={{ background: 'var(--bg-input)' }}>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Time</p>
          <p className="font-bold" style={{ color: 'var(--text-primary)' }}>{timeDisplay}</p>
        </div>
        <div className="rounded-xl p-3 text-center" style={{ background: 'var(--bg-input)' }}>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Distance</p>
          <p className="font-bold" style={{ color: 'var(--text-primary)' }}>{distanceMiles.toFixed(2)} mi</p>
        </div>
        <div className="rounded-xl p-3 text-center" style={{ background: 'var(--bg-input)' }}>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Pace</p>
          <p className="font-bold" style={{ color: 'var(--text-primary)' }}>{pace}</p>
        </div>
      </div>

      {mapMyRun && routeCoords.length > 0 && (
        <div className="mb-4 rounded-xl overflow-hidden" style={{ height: 240 }}>
          <MapContainer center={routeCoords[routeCoords.length - 1]} zoom={15} style={{ height: '100%', width: '100%' }}>
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <Marker position={routeCoords[routeCoords.length - 1]} />
            <Polyline positions={routeCoords} pathOptions={{ color: '#EAB308', weight: 4 }} />
          </MapContainer>
        </div>
      )}

      {!running && !countingDown && (
        <>
          <button onClick={() => setMapMyRun(v => !v)} className="w-full rounded-xl py-2 font-semibold mb-2" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
            {mapMyRun ? 'Map my run: On' : 'Map my run: Off'}
          </button>
          <button
            onClick={() => {
              setCountdownVal(selectedCountdown)
              setCountingDown(selectedCountdown > 0)
              if (selectedCountdown === 0) startGPS()
            }}
            className="w-full rounded-xl py-3 font-black"
            style={{ background: 'var(--accent)', color: '#000' }}
          >
            Start Run
          </button>
        </>
      )}

      {running && (
        <button
          onClick={finishRun}
          disabled={saving}
          className="w-full rounded-xl py-3 font-black"
          style={{ background: 'var(--accent)', color: '#000', opacity: saving ? 0.5 : 1 }}
        >
          {saving ? 'Saving...' : 'Finish Run'}
        </button>
      )}

      {gpsError && <p className="mt-3 text-sm" style={{ color: 'var(--accent)' }}>{gpsError}</p>}

      {showPostCheckIn && savedRunId && (
        <PostRunCheckIn runId={savedRunId} onDone={() => { setShowPostCheckIn(false); navigate('/') }} />
      )}

      <Link to="/log-run" className="mt-5 inline-block text-sm" style={{ color: 'var(--text-muted)' }}>← Back</Link>
    </div>
  )
}
