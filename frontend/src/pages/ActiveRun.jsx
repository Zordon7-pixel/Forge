import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { MapContainer, Marker, Polyline, TileLayer } from 'react-leaflet'
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

const TRACK_LAP_MILES = 0.2485

export default function ActiveRun() {
  const location = useLocation()
  const navigate = useNavigate()
  const selectedCountdown = location?.state?.countdown ?? 3
  const watchMetrics = location?.state?.watchMetrics || null

  const [countdownVal, setCountdownVal] = useState(selectedCountdown)
  const [countingDown, setCountingDown] = useState(selectedCountdown > 0)
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [distanceMiles, setDistanceMiles] = useState(0)
  const [gpsError, setGpsError] = useState('')
  const [saving, setSaving] = useState(false)
  const [showPostCheckIn, setShowPostCheckIn] = useState(false)
  const [savedRunId, setSavedRunId] = useState(null)
  const [mapMyRun, setMapMyRun] = useState(location?.state?.mapMyRun ?? true)
  const [routeCoords, setRouteCoords] = useState([])
  const [surfaceSuggestion, setSurfaceSuggestion] = useState('')
  const [trackMode, setTrackMode] = useState(location?.state?.trackMode ?? false)
  const [lapSplits, setLapSplits] = useState([])
  const [lapToast, setLapToast] = useState('')
  const [trackPromptOpen, setTrackPromptOpen] = useState(false)

  const watchRef = useRef(null)
  const lastPointRef = useRef(null)
  const loopDistRef = useRef(0)
  const startPointRef = useRef(null)
  const lapStartElapsedRef = useRef(0)
  const nextLapMarkRef = useRef(TRACK_LAP_MILES)
  const trackPromptedRef = useRef(false)

  const checkSurface = async (lat, lon) => {
    try {
      const query = `[out:json];way["leisure"="track"](around:100,${lat},${lon});out;`
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`
      })
      const data = await res.json()
      if (Array.isArray(data?.elements) && data.elements.length > 0) {
        setSurfaceSuggestion('You appear to be near a running track. Are you running on the track?')
      } else {
        setSurfaceSuggestion('Surface suggestion: road/path')
      }
    } catch {
      setSurfaceSuggestion('Surface suggestion: road/path')
    }
  }

  const startGPS = () => {
    setRunning(true)
    if (!navigator?.geolocation || !mapMyRun) return

    watchRef.current = navigator.geolocation.watchPosition(
      pos => {
        const point = { lat: pos.coords.latitude, lon: pos.coords.longitude }
        if (!startPointRef.current) {
          startPointRef.current = point
          checkSurface(point.lat, point.lon)
        }

        if (lastPointRef.current) {
          const segment = haversineMiles(lastPointRef.current, point)
          if (segment > 0 && segment < 0.25) {
            setDistanceMiles(v => v + segment)
            loopDistRef.current += segment
          }
        }

        setRouteCoords((prev) => [...prev, [point.lat, point.lon]])
        lastPointRef.current = point
      },
      err => setGpsError(err?.message || 'Unable to access GPS.'),
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

  useEffect(() => () => {
    if (watchRef.current != null && navigator?.geolocation) navigator.geolocation.clearWatch(watchRef.current)
  }, [])

  useEffect(() => {
    if (!mapMyRun || trackPromptedRef.current || !startPointRef.current) return
    if (loopDistRef.current > 0.37) return
    const maybeLoopDistance = loopDistRef.current
    const backToStart = lastPointRef.current ? haversineMiles(startPointRef.current, lastPointRef.current) : 99
    if (maybeLoopDistance >= 0.236 && maybeLoopDistance <= 0.261 && backToStart < 0.03) {
      trackPromptedRef.current = true
      setTrackPromptOpen(true)
    }
  }, [distanceMiles, mapMyRun])

  useEffect(() => {
    if (!trackMode) return
    while (distanceMiles >= nextLapMarkRef.current) {
      const split = elapsed - lapStartElapsedRef.current
      lapStartElapsedRef.current = elapsed
      nextLapMarkRef.current += TRACK_LAP_MILES
      setLapSplits(prev => [...prev, split])
      setLapToast(`Lap ${lapSplits.length + 1} split: ${Math.floor(split / 60)}:${String(split % 60).padStart(2, '0')}`)
      setTimeout(() => setLapToast(''), 1800)
    }
  }, [distanceMiles, trackMode, elapsed, lapSplits.length])

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

  const watchMetricRows = useMemo(() => {
    if (!watchMetrics) return []
    const rows = [
      ['Avg HR', watchMetrics.avg_heart_rate && `${watchMetrics.avg_heart_rate} bpm`],
      ['Max HR', watchMetrics.max_heart_rate && `${watchMetrics.max_heart_rate} bpm`],
      ['Cadence', watchMetrics.cadence_spm && `${watchMetrics.cadence_spm} spm`],
      ['Elevation Gain', watchMetrics.elevation_gain && `${watchMetrics.elevation_gain} ft`],
      ['VO2 Max', watchMetrics.vo2_max],
      ['Calories', watchMetrics.calories && `${watchMetrics.calories}`],
      ['Training Effect', watchMetrics.training_effect_aerobic && `Aerobic ${watchMetrics.training_effect_aerobic} / Anaerobic ${watchMetrics.training_effect_anaerobic || 0}`],
      ['Recovery Time', watchMetrics.recovery_time_hours && `${watchMetrics.recovery_time_hours} hrs`],
      ['Surface', watchMetrics.detected_surface_type],
      ['Temperature', watchMetrics.temperature_f && `${watchMetrics.temperature_f}°F`]
    ]
    return rows.filter(([, v]) => v)
  }, [watchMetrics])

  const saveRun = async () => {
    setSaving(true)
    try {
      const res = await api.post('/runs', {
        date: new Date().toISOString().slice(0, 10),
        type: trackMode ? 'track' : 'easy',
        run_surface: trackMode ? 'track' : 'outdoor',
        distance_miles: distanceMiles,
        duration_seconds: elapsed,
        notes: trackMode ? 'Track mode run' : '',
        perceived_effort: 5,
        route_coords: routeCoords.map(([lat, lon]) => ({ lat, lon })),
        watch_mode: trackMode ? 'track' : null,
        pace_splits: lapSplits,
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
    if (watchRef.current != null && navigator?.geolocation) navigator.geolocation.clearWatch(watchRef.current)
    saveRun()
  }

  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
      {countingDown && <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: '#000' }}><p className="text-9xl font-black" style={{ color: 'var(--accent)' }}>{countdownVal}</p></div>}
      <h2 className="text-2xl font-black mb-4" style={{ color: 'var(--text-primary)' }}>Active Run</h2>

      {!running && !countingDown && (
        <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--bg-input)' }}>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Are you doing a track workout?</p>
          <div className="flex gap-2 mt-2">
            <button onClick={() => setTrackMode(true)} className="rounded-lg px-3 py-1 text-xs font-bold" style={{ background: trackMode ? 'var(--accent)' : 'var(--bg-card)', color: trackMode ? '#000' : 'var(--text-muted)' }}>Yes (track intervals)</button>
            <button onClick={() => setTrackMode(false)} className="rounded-lg px-3 py-1 text-xs font-bold" style={{ background: !trackMode ? 'var(--accent)' : 'var(--bg-card)', color: !trackMode ? '#000' : 'var(--text-muted)' }}>No (road run)</button>
          </div>
        </div>
      )}

      {surfaceSuggestion && <p className="text-xs mb-2" style={{ color: 'var(--accent)' }}>{surfaceSuggestion}</p>}
      {lapToast && <div className="mb-2 rounded-lg p-2 text-sm" style={{ background: 'rgba(234,179,8,0.15)', color: 'var(--text-primary)' }}>{lapToast}</div>}

      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="rounded-xl p-3 text-center" style={{ background: 'var(--bg-input)' }}><p className="text-xs" style={{ color: 'var(--text-muted)' }}>Time</p><p className="font-bold">{timeDisplay}</p></div>
        <div className="rounded-xl p-3 text-center" style={{ background: 'var(--bg-input)' }}><p className="text-xs" style={{ color: 'var(--text-muted)' }}>Distance</p><p className="font-bold">{distanceMiles.toFixed(2)} mi</p></div>
        <div className="rounded-xl p-3 text-center" style={{ background: 'var(--bg-input)' }}><p className="text-xs" style={{ color: 'var(--text-muted)' }}>Pace</p><p className="font-bold">{pace}</p></div>
      </div>

      {trackMode && (
        <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--bg-input)' }}>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Track Mode</p>
          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>Laps: {lapSplits.length} · Avg Lap: {lapSplits.length ? `${Math.floor((lapSplits.reduce((a,b)=>a+b,0)/lapSplits.length)/60)}:${String(Math.round((lapSplits.reduce((a,b)=>a+b,0)/lapSplits.length)%60)).padStart(2,'0')}` : '--'}</p>
          {lapSplits.length > 0 && <p className="text-xs" style={{ color: 'var(--accent)' }}>4 laps = 1 mile marker · Current lap {lapSplits.length + 1}</p>}
        </div>
      )}

      {mapMyRun && routeCoords.length > 0 && <div className="mb-4 rounded-xl overflow-hidden" style={{ height: 240 }}><MapContainer center={routeCoords[routeCoords.length - 1]} zoom={15} style={{ height: '100%', width: '100%' }}><TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" /><Marker position={routeCoords[routeCoords.length - 1]} /><Polyline positions={routeCoords} pathOptions={{ color: '#EAB308', weight: 4 }} /></MapContainer></div>}

      {watchMetricRows.length > 0 && (
        <div className="grid grid-cols-2 gap-2 mb-3">
          {watchMetricRows.map(([label, value]) => (
            <div key={label} className="rounded-lg p-2" style={{ background: 'var(--bg-input)' }}>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</p>
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</p>
            </div>
          ))}
        </div>
      )}

      {!running && !countingDown && <><button onClick={() => setMapMyRun(v => !v)} className="w-full rounded-xl py-2 font-semibold mb-2" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}>{mapMyRun ? 'Map my run: On' : 'Map my run: Off'}</button><button onClick={() => { setCountdownVal(selectedCountdown); setCountingDown(selectedCountdown > 0); if (selectedCountdown === 0) startGPS() }} className="w-full rounded-xl py-3 font-black" style={{ background: 'var(--accent)', color: '#000' }}>Start Run</button></>}
      {running && <button onClick={finishRun} disabled={saving} className="w-full rounded-xl py-3 font-black" style={{ background: 'var(--accent)', color: '#000', opacity: saving ? 0.5 : 1 }}>{saving ? 'Saving...' : 'Finish Run'}</button>}
      {gpsError && <p className="mt-3 text-sm" style={{ color: 'var(--accent)' }}>{gpsError}</p>}

      {trackPromptOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)' }}>
          <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', width: '90%', maxWidth: 360 }}>
            <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>Looks like you might be running on a track — are you doing track intervals?</p>
            <div className="mt-3 flex gap-2">
              <button className="flex-1 rounded-lg py-2 font-bold" style={{ background: 'var(--accent)', color: '#000' }} onClick={() => { setTrackMode(true); setTrackPromptOpen(false) }}>Yes</button>
              <button className="flex-1 rounded-lg py-2" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }} onClick={() => setTrackPromptOpen(false)}>No</button>
            </div>
          </div>
        </div>
      )}

      {showPostCheckIn && savedRunId && <PostRunCheckIn runId={savedRunId} onDone={() => { setShowPostCheckIn(false); navigate('/') }} />}
      <Link to="/log-run" className="mt-5 inline-block text-sm" style={{ color: 'var(--text-muted)' }}>← Back</Link>
    </div>
  )
}
