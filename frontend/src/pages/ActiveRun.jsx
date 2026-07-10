import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { MapContainer, Marker, Polyline, TileLayer } from 'react-leaflet'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { useUnits } from '../context/UnitsContext'
import api from '../lib/api'
import { queueRequest } from '../lib/offlineQueue'
import PostRunCheckIn from '../components/PostRunCheckIn'
import AICoachFeedbackCard from '../components/AICoachFeedbackCard'
import WorkoutCard from '../components/WorkoutCard'

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation')

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
  { key: 'Z3', min: 0.7, max: 0.8, name: 'Tempo', color: 'var(--success)' },
  { key: 'Z4', min: 0.8, max: 0.9, name: 'Threshold', color: 'var(--accent)' },
  { key: 'Z5', min: 0.9, max: 1.01, name: 'Max Effort', color: 'var(--danger)' },
]

function getZone(hr, maxHr) {
  if (!hr || !maxHr) return null
  const pct = hr / maxHr
  if (pct < ZONES[0].min) return { key: 'Z0', min: 0, max: ZONES[0].min, name: 'Below Z1', color: '#9CA3AF', pct }
  const zone = ZONES.find(z => pct >= z.min && pct < z.max) || ZONES[4]
  return { ...zone, pct }
}

function todayISO() {
  const now = new Date()
  const offsetDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
  return offsetDate.toISOString().slice(0, 10)
}

function createClientRunId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16)
    const nibble = char === 'x' ? value : (value & 0x3) | 0x8
    return nibble.toString(16)
  })
}

function displayDistanceForUnit(miles, units, fmt) {
  const distance = Number(miles || 0)
  if (units === 'metric') return (distance * 1.60934).toFixed(2)
  return distance.toFixed(2)
}

function formatGapDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)))
  const minutes = Math.floor(total / 60)
  const remaining = total % 60
  if (minutes <= 0) return `${remaining}s`
  if (remaining <= 0) return `${minutes}m`
  return `${minutes}m ${remaining}s`
}

export default function ActiveRun() {
  const location = useLocation()
  const navigate = useNavigate()
  const { fmt } = useUnits()
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
  const [saveError, setSaveError] = useState('')
  const [queuedOffline, setQueuedOffline] = useState(false)
  const [showPostCheckIn, setShowPostCheckIn] = useState(false)
  const [savedRunId, setSavedRunId] = useState(null)
  const [savedHeatDrift, setSavedHeatDrift] = useState(null)
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
  const [gpsStarted, setGpsStarted] = useState(false)
  const [gpsGapSummary, setGpsGapSummary] = useState(null)
  const watchRef = useRef(null)
  const nativeWatchRef = useRef(false)
  const lastPointRef = useRef(null)
  const lastFixAtRef = useRef(null)
  const gpsGapSecondsRef = useRef(0)
  const gpsGapCountRef = useRef(0)
  const discardedSegmentRef = useRef(false)
  const startTimestampRef = useRef(null)
  const clientRunIdRef = useRef(createClientRunId())

  useEffect(() => {
    api.get('/auth/me')
      .then(r => setUserProfile(r.data?.user || null))
      .catch((err) => { console.error('[ActiveRun] Failed to load profile:', err.message) })
  }, [])
  
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await api.get('/watch-sync/status')
        if (res.data?.avg_heart_rate) {
          setLiveHr(Number(res.data.avg_heart_rate))
          setHrLastUpdated(Date.now())
        }
      } catch (err) {
        console.error('[ActiveRun] Failed to poll watch status:', err.message)
      }
    }
    if (!running) return
    poll()
    const t = setInterval(poll, 5000)
    return () => clearInterval(t)
  }, [running])

  const maxHr = userProfile?.max_heart_rate || (userProfile?.age ? 220 - Number(userProfile.age) : null)
  const hrZone = getZone(liveHr, maxHr)

  const handlePoint = useCallback((lat, lon, alt, tsMillis) => {
    const latitude = Number(lat)
    const longitude = Number(lon)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return
    setGpsAvailable(true)
    setGpsStarted(true)

    const parsedTs = Number(tsMillis)
    const fixAt = Number.isFinite(parsedTs) ? parsedTs : Date.now()
    if (lastFixAtRef.current) {
      const gapSeconds = Math.round((fixAt - lastFixAtRef.current) / 1000)
      if (gapSeconds > 15) {
        gpsGapSecondsRef.current += gapSeconds
        gpsGapCountRef.current += 1
      }
    }
    const point = { lat: latitude, lon: longitude, alt: alt ?? null }
    if (lastPointRef.current) {
      const segment = haversineMiles(lastPointRef.current, point)
      if (segment > 0 && segment < 0.25) {
        setDistanceMiles(v => v + segment)
      } else if (segment >= 0.25) {
        discardedSegmentRef.current = true
      }
    }
    setRouteCoords((prev) => [...prev, [point.lat, point.lon, point.alt]])
    lastPointRef.current = point
    lastFixAtRef.current = fixAt
  }, [])

  const clearActiveWatch = useCallback(async () => {
    const id = watchRef.current
    if (id == null) return
    watchRef.current = null
    const wasNative = nativeWatchRef.current
    nativeWatchRef.current = false
    if (wasNative) {
      try {
        await BackgroundGeolocation.removeWatcher({ id })
      } catch (err) {
        console.error('[ActiveRun] failed to remove native GPS watcher:', err)
      }
    } else if (typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        navigator.geolocation.clearWatch(id)
      } catch (err) {
        console.error('[ActiveRun] failed to clear web GPS watcher:', err)
      }
    }
  }, [])

  const startWebGeolocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsError('GPS unavailable — tracking time and effort only')
      setGpsAvailable(false)
      setGpsStarted(false)
      return false
    }

    nativeWatchRef.current = false
    watchRef.current = navigator.geolocation.watchPosition(
      pos => {
        handlePoint(pos.coords.latitude, pos.coords.longitude, pos.coords.altitude, Date.now())
      },
      () => {
        setGpsError('GPS unavailable — tracking time and effort only')
        setGpsAvailable(false)
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 }
    )
    return true
  }, [handlePoint])

  const startGPS = useCallback(async () => {
    setSaveError('')
    setQueuedOffline(false)
    setGpsGapSummary(null)
    lastFixAtRef.current = null
    gpsGapSecondsRef.current = 0
    gpsGapCountRef.current = 0
    discardedSegmentRef.current = false
    if (!startTimestampRef.current) startTimestampRef.current = Date.now() - (elapsed * 1000)
    setRunning(true)
    if (!mapMyRun) {
      setGpsStarted(false)
      setGpsAvailable(false)
      setGpsError('Route recording is off — enter your distance when you finish')
      return
    }

    if (Capacitor.isNativePlatform()) {
      try {
        const id = await BackgroundGeolocation.addWatcher({
          backgroundMessage: 'Forge is recording your run',
          backgroundTitle: 'Forge',
          requestPermissions: true,
          stale: false,
          distanceFilter: 5,
        }, (loc, err) => {
          if (err) {
            console.error('[ActiveRun] bg-geo error', err.message)
            return
          }
          if (!loc) return
          handlePoint(loc.latitude, loc.longitude, loc.altitude, loc.time || Date.now())
        })
        watchRef.current = id
        nativeWatchRef.current = true
        return
      } catch (err) {
        console.warn('[ActiveRun] background geolocation unavailable, falling back to web GPS:', err?.message)
      }
    }

    startWebGeolocation()
  }, [elapsed, handlePoint, mapMyRun, startWebGeolocation])

  useEffect(() => {
    if (!countingDown) return
    if (countdownVal <= 0) { setCountingDown(false); startGPS(); return }
    const t = setTimeout(() => setCountdownVal(v => v - 1), 1000)
    return () => clearTimeout(t)
  }, [countingDown, countdownVal, startGPS])

  useEffect(() => {
    if (!running) return
    const updateElapsed = () => {
      if (!startTimestampRef.current) return
      setElapsed(Math.max(0, Math.round((Date.now() - startTimestampRef.current) / 1000)))
    }
    updateElapsed()
    const t = setInterval(updateElapsed, 1000)
    return () => clearInterval(t)
  }, [running])

  useEffect(() => () => { clearActiveWatch() }, [clearActiveWatch])

  const pace = useMemo(() => {
    const dist = gpsAvailable ? distanceMiles : Number(manualDistance || distanceMiles || 0)
    if (!dist || !elapsed) return '--'
    const secondsPerMile = elapsed / dist
    return fmt.pace(secondsPerMile)
  }, [distanceMiles, elapsed, manualDistance, gpsAvailable, fmt])

  const timeDisplay = useMemo(() => {
    const h = Math.floor(elapsed / 3600), m = Math.floor((elapsed % 3600) / 60), s = elapsed % 60
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${m}:${String(s).padStart(2, '0')}`
  }, [elapsed])

  const { units } = useUnits()

  const getGpsGapSummary = () => {
    if (!mapMyRun || !gpsStarted) return null
    const totalGapSeconds = gpsGapSecondsRef.current
    const discardedCatchUp = discardedSegmentRef.current
    if (totalGapSeconds <= 60 && !discardedCatchUp) return null
    return {
      seconds: totalGapSeconds,
      count: gpsGapCountRef.current,
      discardedCatchUp,
    }
  }

  const buildGpsGapNote = () => {
    const summary = getGpsGapSummary()
    if (!summary) return ''
    const pieces = []
    if (summary.seconds > 0) pieces.push(`GPS signal paused for about ${formatGapDuration(summary.seconds)} across ${summary.count} gap${summary.count === 1 ? '' : 's'}`)
    if (summary.discardedCatchUp) pieces.push('one or more large catch-up segments were excluded from distance')
    return `[gps_gap_notice:${pieces.join('; ')}. Distance/route may be incomplete.]`
  }

  const buildRunPayload = () => {
    const runSurface = runEnvironment === 'indoor' && surface === 'treadmill' ? 'treadmill' : surface
    const shouldUseManualDistance = !gpsStarted || !gpsAvailable || distanceMiles <= 0
    let finalDistance = shouldUseManualDistance ? Number(manualDistance || 0) : distanceMiles
    if (shouldUseManualDistance && units === 'metric') {
      finalDistance = fmt.milesFromKm(finalDistance)
    }
    return {
      id: clientRunIdRef.current,
      date: todayISO(),
      type: runType,
      run_surface: runSurface,
      surface: runSurface,
      distance_miles: finalDistance,
      duration_seconds: elapsed,
      notes: buildGpsGapNote(),
      perceived_effort: 5,
      gps_available: gpsStarted && gpsAvailable,
      avg_heart_rate: liveHr || null,
      route_coords: routeCoords.map(([lat, lon, alt]) => ({ lat, lon, alt: alt ?? null })),
      treadmill_brand: treadmillBrand || null
    }
  }
  
  const saveRun = async () => {
    setSaving(true)
    setSaveError('')
    setQueuedOffline(false)
    const payload = buildRunPayload()
    try {
      const res = await api.post('/runs', payload)
      const runId = res.data?.id || res.data?.run?.id
      if (runId) {
        setSavedRunId(runId)
        setAwaitingManualDistance(false)
        setSavedHeatDrift(res.data?.heatDrift || null)
        setShowAiCard(true)
        setAiLoading(true)
        try {
          const fb = await api.post('/ai/session-feedback', { sessionType: 'run', sessionId: runId })
          setAiFeedback(fb.data?.feedback || null)
        } catch (err) {
          console.error('[ActiveRun] Failed to load AI run feedback:', err.message)
          setAiFeedback({ analysis: 'Good work completing your run.', didWell: 'You stayed consistent and got the session done.', suggestion: 'Keep effort smooth and controlled on your next run.', recovery: 'easy day' })
        } finally {
          setAiLoading(false)
        }
        setShowPostCheckIn(true)
      }
    } catch (err) {
      console.error('Failed to save run:', err)
      if (!err?.response || Number(err?.response?.status || 0) >= 500) {
        await queueRequest('/api/runs', 'POST', payload)
        setQueuedOffline(true)
        setSavedRunId(payload.id)
        setAwaitingManualDistance(false)
        setSaveError('Saved offline — Forge will sync this run when your connection is back.')
      } else {
        setSaveError(err?.response?.data?.error || 'Could not save this run. Check the details and try again.')
      }
    } finally { setSaving(false) }
  }

  const finishRun = async () => {
    setRunning(false)
    const gapSummary = getGpsGapSummary()
    if (gapSummary) setGpsGapSummary(gapSummary)
    if (!gpsStarted || !gpsAvailable || distanceMiles <= 0) {
      setManualDistance((current) => current || displayDistanceForUnit(distanceMiles, units, fmt))
      setAwaitingManualDistance(true)
      await clearActiveWatch()
      return
    }
    const savePromise = saveRun()
    await clearActiveWatch()
    await savePromise
  }

  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
      {countingDown && <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: '#000' }}><div className="text-center"><p className="text-9xl font-black" style={{ color: 'var(--accent)' }}>{countdownVal}</p><p className="text-xl mt-4" style={{ color: 'var(--text-muted)' }}>Get ready...</p></div></div>}
      <h2 className="t-micro mb-4">Active Run</h2>

      <div className="mb-5 text-center">
        <p className="t-micro">Elapsed</p>
        <p className="stat-num mt-1" style={{ color: 'var(--text-primary)', fontSize: 64, lineHeight: 1 }}>{timeDisplay}</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <p className="t-micro">Distance</p>
            <p className="stat-num mt-1" style={{ color: 'var(--text-primary)', fontSize: 28, lineHeight: 1.1 }}>{fmt.distance(distanceMiles, 2)}</p>
          </div>
          <div>
            <p className="t-micro">Pace</p>
            <p className="stat-num mt-1" style={{ color: 'var(--text-primary)', fontSize: 28, lineHeight: 1.1 }}>{pace}</p>
          </div>
        </div>
      </div>

      <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--bg-input)' }}>
        <p className="t-micro">Heart Rate</p>
        {liveHr ? (
          <>
            <div className="flex items-center gap-2">
              <p className="stat-num" style={{ color: 'var(--text-primary)', fontSize: 24, lineHeight: 1 }}>{liveHr} bpm</p>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: hrLastUpdated && Date.now() - hrLastUpdated < 10000 ? 'var(--success)' : '#6b7280', animation: hrLastUpdated && Date.now() - hrLastUpdated < 10000 ? 'pulse 2s infinite' : 'none' }} />
              {hrLastUpdated && Date.now() - hrLastUpdated > 60000 && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>(last known)</span>}
              {hrZone && <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: `${hrZone.color}22`, color: hrZone.color }}>{hrZone.key} · {hrZone.name}</span>}
            </div>
            {hrZone && <div className="mt-3 h-2 rounded-full" style={{ background: 'var(--bg-base)' }}><div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, (hrZone.pct * 100))) }%`, background: hrZone.color, transition: 'width var(--dur-med) var(--ease-out)' }} /></div>}
            <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
          </>
        ) : <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Connect watch for live HR</p>}
      </div>

      {(!gpsAvailable || gpsError) && <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)', color: 'var(--accent)' }}>{gpsError || 'GPS unavailable — tracking time and effort only'}</div>}
      {gpsGapSummary && (
        <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)', color: 'var(--accent)' }}>
          GPS paused during this run{gpsGapSummary.seconds > 0 ? ` for about ${formatGapDuration(gpsGapSummary.seconds)}` : ''}. Review the distance; Forge saves a note that the route may be incomplete.
        </div>
      )}
      {saveError && <div className="rounded-xl p-3 mb-3" style={{ background: queuedOffline ? 'rgba(34,197,94,0.12)' : 'var(--danger-dim)', border: `1px solid ${queuedOffline ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`, color: queuedOffline ? 'var(--success)' : 'var(--danger)' }}>{saveError}</div>}

      {mapMyRun && routeCoords.length > 0 && <div className="mb-4 rounded-2xl overflow-hidden" style={{ minHeight: 280, height: 280 }}><MapContainer center={routeCoords[routeCoords.length - 1]} zoom={15} style={{ height: '100%', width: '100%' }}><TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" /><Marker position={routeCoords[routeCoords.length - 1]} /><Polyline positions={routeCoords} pathOptions={{ color: 'var(--accent)', weight: 4 }} /></MapContainer></div>}

      {!running && !countingDown && !awaitingManualDistance && <><button onClick={() => setMapMyRun(v => !v)} className="pressable w-full rounded-xl py-2 font-semibold mb-2" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}>{mapMyRun ? 'Record route: On' : 'Record route: Off'}</button><button onClick={() => { setCountdownVal(selectedCountdown); setCountingDown(selectedCountdown > 0); if (selectedCountdown === 0) startGPS() }} className="pressable w-full rounded-xl py-3 font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>Start Run</button></>}
      {running && <button onClick={finishRun} disabled={saving} className="pressable w-full rounded-xl py-3 font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)', opacity: saving ? 0.5 : 1, minHeight: 56 }}>{saving ? 'Saving...' : 'Finish Run'}</button>}

      {awaitingManualDistance && (
        <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)' }}>
          <p className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>How far did you run? ({fmt.distanceLabel})</p>
          {distanceMiles > 0 && <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>Forge measured {fmt.distance(distanceMiles, 2)} before GPS stopped or route recording ended. Adjust if needed.</p>}
          <input value={manualDistance} onChange={e => setManualDistance(e.target.value)} type="number" min="0" step="0.1" className="w-full rounded-xl px-3 py-2" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} placeholder={fmt.distanceLabel} />
          <button onClick={saveRun} className="w-full mt-2 rounded-xl py-2 font-semibold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>Save Run</button>
        </div>
      )}

      {!running && !countingDown && savedRunId && (
        <WorkoutCard
          workoutType="Run"
          date={new Date().toISOString()}
          stats={{
            distance: fmt.distance(gpsAvailable ? distanceMiles : Number(manualDistance || 0), 2),
            pace,
            duration: timeDisplay,
          }}
          summaryText={`FORGE Run · ${fmt.distance(gpsAvailable ? distanceMiles : Number(manualDistance || 0), 2)} · ${pace} · ${timeDisplay}`}
        />
      )}

      {showPostCheckIn && savedRunId && <PostRunCheckIn runId={savedRunId} heatDrift={savedHeatDrift} onDone={() => { setShowPostCheckIn(false); navigate('/') }} />}
      <AICoachFeedbackCard open={showAiCard} loading={aiLoading} feedback={aiFeedback} sessionId={savedRunId} onClose={() => setShowAiCard(false)} />
      <Link to="/log-run" className="mt-5 inline-block text-sm" style={{ color: 'var(--text-muted)' }}>← Back</Link>
    </div>
  )
}
