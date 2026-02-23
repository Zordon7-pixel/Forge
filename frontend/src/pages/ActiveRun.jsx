import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { MapContainer, Marker, Polyline, TileLayer } from 'react-leaflet'
import api from '../lib/api'
import PostRunCheckIn from '../components/PostRunCheckIn'
import AICoachFeedbackCard from '../components/AICoachFeedbackCard'

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

const ZONES = [
  { key: 'Z1', min: 0.5, max: 0.6, name: 'Recovery', color: '#6B7280' },
  { key: 'Z2', min: 0.6, max: 0.7, name: 'Aerobic Base', color: '#3B82F6' },
  { key: 'Z3', min: 0.7, max: 0.8, name: 'Tempo', color: '#22C55E' },
  { key: 'Z4', min: 0.8, max: 0.9, name: 'Threshold', color: '#EAB308' },
  { key: 'Z5', min: 0.9, max: 1.01, name: 'Max Effort', color: '#EF4444' },
]

function getZone(hr, maxHr) {
  if (!hr || !maxHr) return null
  const pct = hr / maxHr
  const zone = ZONES.find(z => pct >= z.min && pct < z.max) || ZONES[4]
  return { ...zone, pct }
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
  const [gpsAvailable, setGpsAvailable] = useState(true)
  const [manualDistance, setManualDistance] = useState('')
  const [awaitingManualDistance, setAwaitingManualDistance] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showPostCheckIn, setShowPostCheckIn] = useState(false)
  const [savedRunId, setSavedRunId] = useState(null)
  const [showAiCard, setShowAiCard] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiFeedback, setAiFeedback] = useState(null)
  const [mapMyRun, setMapMyRun] = useState(location?.state?.mapMyRun ?? false)
  const [routeCoords, setRouteCoords] = useState([])
  const [runEnvironment, setRunEnvironment] = useState(location?.state?.runEnvironment ?? 'outdoor')
  const [surface, setSurface] = useState(location?.state?.surface ?? 'road')
  const [runType, setRunType] = useState(location?.state?.runType ?? 'run')
  const [treadmillBrand, setTreadmillBrand] = useState(location?.state?.treadmillBrand ?? null)
  const [userProfile, setUserProfile] = useState(null)
  const [liveHr, setLiveHr] = useState(null)
  const [hrLastUpdated, setHrLastUpdated] = useState(null)
  const watchRef = useRef(null)
  const lastPointRef = useRef(null)

  useEffect(() => { api.get('/auth/me').then(r => setUserProfile(r.data?.user || null)).catch(() => {}) }, [])
  
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await api.get('/watch-sync/status')
        if (res.data?.avg_heart_rate) {
          setLiveHr(Number(res.data.avg_heart_rate))
          setHrLastUpdated(Date.now())
        }
      } catch {}
    }
    if (!running) return
    poll()
    const t = setInterval(poll, 5000)
    return () => clearInterval(t)
  }, [running])

  const maxHr = userProfile?.max_heart_rate || (userProfile?.age ? 220 - Number(userProfile.age) : null)
  const hrZone = getZone(liveHr, maxHr)

  const startGPS = () => {
    setRunning(true)
    if (!mapMyRun) return
    if (!navigator?.geolocation) {
      setGpsError('GPS unavailable — tracking time and effort only')
      setGpsAvailable(false)
      return
    }

    watchRef.current = navigator.geolocation.watchPosition(
      pos => {
        setGpsAvailable(true)
        const point = { lat: pos.coords.latitude, lon: pos.coords.longitude }
        if (lastPointRef.current) {
          const segment = haversineMiles(lastPointRef.current, point)
          if (segment > 0 && segment < 0.25) setDistanceMiles(v => v + segment)
        }
        setRouteCoords((prev) => [...prev, [point.lat, point.lon]])
        lastPointRef.current = point
      },
      () => {
        setGpsError('GPS unavailable — tracking time and effort only')
        setGpsAvailable(false)
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 }
    )
  }

  useEffect(() => {
    if (!countingDown) return
    if (countdownVal <= 0) { setCountingDown(false); startGPS(); return }
    const t = setTimeout(() => setCountdownVal(v => v - 1), 1000)
    return () => clearTimeout(t)
  }, [countingDown, countdownVal])

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setElapsed(v => v + 1), 1000)
    return () => clearInterval(t)
  }, [running])

  useEffect(() => () => { if (watchRef.current != null && navigator?.geolocation) navigator.geolocation.clearWatch(watchRef.current) }, [])

  const pace = useMemo(() => {
    const dist = gpsAvailable ? distanceMiles : Number(manualDistance || distanceMiles || 0)
    if (!dist || !elapsed) return '--'
    const p = elapsed / 60 / dist
    const m = Math.floor(p)
    const s = Math.round((p - m) * 60)
    return `${m}:${String(s).padStart(2, '0')} /mi`
  }, [distanceMiles, elapsed, manualDistance, gpsAvailable])

  const timeDisplay = useMemo(() => {
    const h = Math.floor(elapsed / 3600), m = Math.floor((elapsed % 3600) / 60), s = elapsed % 60
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${m}:${String(s).padStart(2, '0')}`
  }, [elapsed])

  const saveRun = async () => {
    setSaving(true)
    try {
      const runSurface = runEnvironment === 'indoor' && surface === 'treadmill' ? 'treadmill' : surface
      const finalDistance = gpsAvailable ? distanceMiles : Number(manualDistance || 0)
      const res = await api.post('/runs', {
        date: new Date().toISOString().slice(0, 10),
        type: runType,
        run_surface: runSurface,
        distance_miles: finalDistance,
        duration_seconds: elapsed,
        notes: '',
        perceived_effort: 5,
        gps_available: gpsAvailable,
        avg_heart_rate: liveHr || null,
        route_coords: routeCoords.map(([lat, lon]) => ({ lat, lon })),
        treadmill_type: treadmillBrand || null
      })
      const runId = res.data?.id || res.data?.run?.id
      if (runId) {
        setSavedRunId(runId)
        setShowAiCard(true)
        setAiLoading(true)
        try {
          const fb = await api.post('/ai/session-feedback', { sessionType: 'run', sessionId: runId })
          setAiFeedback(fb.data?.feedback || null)
        } catch {
          setAiFeedback({ analysis: 'Good work completing your run.', didWell: 'You stayed consistent and got the session done.', suggestion: 'Keep effort smooth and controlled on your next run.', recovery: 'easy day' })
        } finally {
          setAiLoading(false)
        }
        setShowPostCheckIn(true)
      }
    } catch (err) {
      console.error('Failed to save run:', err)
    } finally { setSaving(false) }
  }

  const finishRun = () => {
    setRunning(false)
    if (watchRef.current != null && navigator?.geolocation) navigator.geolocation.clearWatch(watchRef.current)
    if (!gpsAvailable) { setAwaitingManualDistance(true); return }
    saveRun()
  }

  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
      {countingDown && <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: '#000' }}><div className="text-center"><p className="text-9xl font-black" style={{ color: 'var(--accent)' }}>{countdownVal}</p><p className="text-xl mt-4" style={{ color: 'var(--text-muted)' }}>Get ready...</p></div></div>}
      <h2 className="text-2xl font-black mb-4" style={{ color: 'var(--text-primary)' }}>Active Run</h2>

      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="rounded-xl p-3 text-center" style={{ background: 'var(--bg-input)' }}><p className="text-xs" style={{ color: 'var(--text-muted)' }}>Time</p><p className="font-bold" style={{ color: 'var(--text-primary)' }}>{timeDisplay}</p></div>
        <div className="rounded-xl p-3 text-center" style={{ background: 'var(--bg-input)' }}><p className="text-xs" style={{ color: 'var(--text-muted)' }}>Distance</p><p className="font-bold" style={{ color: 'var(--text-primary)' }}>{distanceMiles.toFixed(2)} mi</p></div>
        <div className="rounded-xl p-3 text-center" style={{ background: 'var(--bg-input)' }}><p className="text-xs" style={{ color: 'var(--text-muted)' }}>Pace</p><p className="font-bold" style={{ color: 'var(--text-primary)' }}>{pace}</p></div>
      </div>

      <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--bg-input)' }}>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Heart Rate</p>
        {liveHr ? (
          <>
            <div className="flex items-center gap-2">
              <p className="font-bold" style={{ color: 'var(--text-primary)' }}>{liveHr} bpm</p>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: hrLastUpdated && Date.now() - hrLastUpdated < 10000 ? '#22c55e' : '#6b7280', animation: hrLastUpdated && Date.now() - hrLastUpdated < 10000 ? 'pulse 2s infinite' : 'none' }} />
              {hrLastUpdated && Date.now() - hrLastUpdated > 60000 && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>(last known)</span>}
              {hrZone && <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: `${hrZone.color}22`, color: hrZone.color }}>{hrZone.key} · {hrZone.name}</span>}
            </div>
            {hrZone && <div className="mt-2 h-1.5 rounded-full" style={{ background: 'var(--bg-base)' }}><div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, (hrZone.pct * 100))) }%`, background: hrZone.color }} /></div>}
            <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
          </>
        ) : <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Connect watch for live HR</p>}
      </div>

      {!gpsAvailable && <div className="rounded-xl p-3 mb-3" style={{ background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.3)', color: 'var(--accent)' }}>GPS unavailable — tracking time and effort only</div>}

      {mapMyRun && routeCoords.length > 0 && <div className="mb-4 rounded-xl overflow-hidden" style={{ height: 240 }}><MapContainer center={routeCoords[routeCoords.length - 1]} zoom={15} style={{ height: '100%', width: '100%' }}><TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" /><Marker position={routeCoords[routeCoords.length - 1]} /><Polyline positions={routeCoords} pathOptions={{ color: '#EAB308', weight: 4 }} /></MapContainer></div>}

      {!running && !countingDown && !awaitingManualDistance && <><button onClick={() => setMapMyRun(v => !v)} className="w-full rounded-xl py-2 font-semibold mb-2" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}>{mapMyRun ? 'Map my run: On' : 'Map my run: Off'}</button><button onClick={() => { setCountdownVal(selectedCountdown); setCountingDown(selectedCountdown > 0); if (selectedCountdown === 0) startGPS() }} className="w-full rounded-xl py-3 font-black" style={{ background: 'var(--accent)', color: '#000' }}>Start Run</button></>}
      {running && <button onClick={finishRun} disabled={saving} className="w-full rounded-xl py-3 font-black" style={{ background: 'var(--accent)', color: '#000', opacity: saving ? 0.5 : 1 }}>{saving ? 'Saving...' : 'Finish Run'}</button>}

      {awaitingManualDistance && (
        <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)' }}>
          <p className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>How far did you run?</p>
          <input value={manualDistance} onChange={e => setManualDistance(e.target.value)} type="number" min="0" step="0.1" className="w-full rounded-xl px-3 py-2" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} placeholder="Miles" />
          <button onClick={saveRun} className="w-full mt-2 rounded-xl py-2 font-semibold" style={{ background: 'var(--accent)', color: '#000' }}>Save Run</button>
        </div>
      )}

      {showPostCheckIn && savedRunId && <PostRunCheckIn runId={savedRunId} onDone={() => { setShowPostCheckIn(false); navigate('/') }} />}
      <AICoachFeedbackCard open={showAiCard} loading={aiLoading} feedback={aiFeedback} sessionId={savedRunId} onClose={() => setShowAiCard(false)} />
      <Link to="/log-run" className="mt-5 inline-block text-sm" style={{ color: 'var(--text-muted)' }}>← Back</Link>
    </div>
  )
}
