import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'
import track from '../lib/track'
import { scrollToFirstError } from '../utils/validation'
import { normalizeExecution, runRouteState, scheduledLiftFromExecution } from '../lib/dailyExecution'

const LEG_OPTIONS = [
  { value: 3, label: 'Fresh' },
  { value: 2, label: 'Okay' },
  { value: 1, label: 'Heavy' },
]

const DRIVE_OPTIONS = [
  { value: 3, label: 'Fired up' },
  { value: 2, label: 'Okay' },
  { value: 1, label: 'Flat' },
]

const TIME_OPTIONS = [
  { value: 20, label: '20 min' },
  { value: 45, label: '45 min' },
  { value: 60, label: '1 hour' },
  { value: 90, label: '1.5 hrs' },
  { value: 120, label: '2+ hrs' },
]

const LIFE_FLAGS = [
  { value: 'long_shift', label: 'Long shift' },
  { value: 'sore', label: 'Sore' },
  { value: 'traveling', label: 'Traveling' },
  { value: 'sick', label: 'Not well' },
  { value: 'stressed', label: 'Stressed' },
  { value: 'all_good', label: 'All good' },
]

function todayISO() {
  const now = new Date()
  const offsetDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
  return offsetDate.toISOString().slice(0, 10)
}

function ReadinessSegment({ title, helper, options, value, onChange, error, errorRef }) {
  return (
    <div ref={errorRef} style={{ marginBottom: 20 }}>
      <div style={{ marginBottom: 12 }}>
        <p style={{ fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 3px' }}>{title}</p>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>{helper}</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
        {options.map(option => {
          const selected = value === option.value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(option.value)}
              style={{
                minHeight: 56,
                borderRadius: 14,
                border: selected ? '2px solid var(--accent)' : '2px solid transparent',
                background: selected ? 'var(--accent-dim)' : 'var(--bg-input)',
                color: selected ? 'var(--accent)' : 'var(--text-muted)',
                boxShadow: selected ? '0 0 14px rgba(234,179,8,0.30)' : 'none',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 900,
                padding: '12px 8px',
                transition: 'all 160ms ease',
              }}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      {error && <p style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>{error}</p>}
    </div>
  )
}

export default function DailyCheckIn({ onComplete }) {
  const navigate = useNavigate()
  const [legs, setLegs] = useState(null)
  const [drive, setDrive] = useState(null)
  const [timeAvailable, setTimeAvailable] = useState(null)
  const [lifeFlags, setLifeFlags] = useState([])
  const [saving, setSaving] = useState(false)
  const [adjustment, setAdjustment] = useState(null)
  const [headline, setHeadline] = useState(null)
  const [drivers, setDrivers] = useState([])
  const [showBreakdown, setShowBreakdown] = useState(false)
  const [todayPlan, setTodayPlan] = useState(null)
  const [workoutHandoff, setWorkoutHandoff] = useState(null)
  const [showStretchGate, setShowStretchGate] = useState(false)
  const [alreadyDone, setAlreadyDone] = useState(false)
  const [fieldErrors, setFieldErrors] = useState({})
  const [submitError, setSubmitError] = useState(null)
  const [preview, setPreview] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState(false)
  const legsErrorRef = useRef(null)
  const driveErrorRef = useRef(null)
  const timeErrorRef = useRef(null)

  useEffect(() => {
    api.get('/checkin/today').then(r => {
      if (r.data) setAlreadyDone(true)
    }).catch((error) => {
      console.error('[DailyCheckIn] today status lookup failed:', error?.message || error)
    })
  }, [])

  const toggleFlag = (val) => {
    if (val === 'all_good') { setLifeFlags(['all_good']); return }
    setLifeFlags(prev => {
      const without = prev.filter(f => f !== 'all_good')
      return prev.includes(val) ? without.filter(f => f !== val) : [...without, val]
    })
  }

  const clearFieldError = (key) => {
    setFieldErrors(prev => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  useEffect(() => {
    if (legs == null || drive == null) {
      setPreview(null)
      setPreviewLoading(false)
      setPreviewError(false)
      return undefined
    }

    let cancelled = false

    const timer = setTimeout(async () => {
      setPreviewLoading(true)
      try {
        const res = await api.post('/checkin/preview', {
          legs,
          drive,
          time_available: timeAvailable,
          life_flags: lifeFlags,
        })
        if (cancelled) return
        setPreview({
          headline: res.data?.headline || null,
          drivers: Array.isArray(res.data?.drivers) ? res.data.drivers : [],
        })
        setPreviewError(false)
      } catch (error) {
        console.error('[DailyCheckIn] preview failed:', error?.message || error)
        if (!cancelled) {
          setPreview(null)
          setPreviewError(true)
        }
      } finally {
        if (!cancelled) setPreviewLoading(false)
      }
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [legs, drive, timeAvailable, lifeFlags])

  const submit = async () => {
    const errors = {}
    if (legs == null) errors.legs = 'Select how your legs feel.'
    if (drive == null) errors.drive = 'Select your drive today.'
    if (!timeAvailable) errors.time_available = 'Select available workout time.'
    setFieldErrors(errors)
    if (Object.keys(errors).length) {
      scrollToFirstError({ legs: legsErrorRef, drive: driveErrorRef, time_available: timeErrorRef }, ['legs', 'drive', 'time_available'].filter(k => errors[k]))
      return
    }
    setSaving(true)
    setSubmitError(null)
    try {
      const res = await api.post('/checkin', {
        date: todayISO(),
        legs,
        drive,
        time_available: timeAvailable,
        life_flags: lifeFlags,
      })
      track('checkin')
      // Resolve the same canonical session Home/Run/Lift use. The legacy plan
      // and recommendation are fallbacks for accounts without a calendar yet.
      try {
        const [planRes, recommendationRes] = await Promise.all([
          api.get('/plans/today', { params: { date: todayISO() } }),
          api.get('/runs/next-recommendation').catch((error) => {
            console.error('[DailyCheckIn] recommendation lookup failed:', error?.message || error)
            return { data: null }
          }),
        ])
        const execution = normalizeExecution(planRes.data)
        const runState = runRouteState(execution)
        const scheduledLift = scheduledLiftFromExecution(execution)

        if (runState && execution.run) {
          const run = execution.run
          const distanceMiles = Number(run.distance_miles || run.distance || 0) || null
          const pace = run.pace_target || run.pace || run.target_pace || null
          const zone = run.target_zone || run.hrZone?.zoneLabel || (run.hrZone?.zone ? `Zone ${run.hrZone.zone}` : null)
          setTodayPlan(run)
          setWorkoutHandoff({
            kind: 'run',
            route: '/run/active',
            state: {
              ...runState,
              countdown: 3,
              runType: run.type || run.workout_type || 'run',
              runEnvironment: 'outdoor',
              mapMyRun: true,
              startAfterWarmup: true,
              workoutTarget: { distanceMiles, pace, zone },
            },
          })
        } else if (scheduledLift) {
          setTodayPlan(scheduledLift)
          setWorkoutHandoff({
            kind: 'strength',
            route: '/log-lift',
            state: {
              planSessionId: scheduledLift.id || null,
              currentWeek: execution.week ?? null,
              scheduledLift,
            },
          })
        } else {
          const legacyPlan = planRes.data?.today || null
          const recommendation = recommendationRes.data && typeof recommendationRes.data === 'object'
            ? recommendationRes.data
            : null
          const source = legacyPlan || recommendation
          const rawType = String(source?.type || source?.workout_type || source?.recommendationType || '').toLowerCase()
          const kind = rawType === 'strength' || rawType === 'lift'
            ? 'strength'
            : rawType === 'rest'
              ? 'rest'
              : source ? 'run' : null

          setTodayPlan(source)
          if (kind === 'run') {
            const distanceMiles = Number(source.distance_miles || source.distance || source.suggestedDistance || 0) || null
            const pace = source.pace_target || source.pace || source.target_pace || source.suggestedPace || null
            const zone = source.zone || source.target_zone || source.targetZone || null
            setWorkoutHandoff({
              kind: 'run',
              route: '/run/active',
              state: {
                countdown: 3,
                runType: rawType || 'easy_run',
                runEnvironment: 'outdoor',
                mapMyRun: true,
                startAfterWarmup: true,
                scheduledRun: source,
                workoutTarget: { distanceMiles, pace, zone },
              },
            })
          } else if (kind === 'strength') {
            setWorkoutHandoff({ kind: 'strength', route: '/log-lift', state: null })
          } else {
            setWorkoutHandoff(kind === 'rest' ? { kind: 'rest', route: '/', state: null } : null)
          }
        }
      } catch (err) {
        console.error('[DailyCheckIn] Failed to fetch today plan:', err)
        setTodayPlan(null)
        setWorkoutHandoff(null)
      }
      const nextHeadline = res.data.headline || res.data.adjustment
      setHeadline(nextHeadline || null)
      setDrivers(Array.isArray(res.data.drivers) ? res.data.drivers : [])
      setShowBreakdown(false)
      if (res.data.adjustment || nextHeadline) setAdjustment(res.data.adjustment || nextHeadline)
      else { onComplete?.(); navigate('/') }
    } catch (err) {
      console.error('[DailyCheckIn] Failed to submit check-in:', err)
      setSubmitError(err.response?.data?.error || 'Check-in failed. Please try again.')
    } finally { setSaving(false) }
  }

  if (alreadyDone) {
    return (
      <div className="forged-branded-screen" style={{ minHeight: '100vh', background: 'var(--bg-base)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16, maxWidth: 480, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        <p style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', textAlign: 'center' }}>You've already checked in today</p>
        <button onClick={() => navigate('/')}
          style={{ background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 700, borderRadius: 14, padding: '16px 32px', border: 'none', cursor: 'pointer' }}>
          Go to Dashboard
        </button>
      </div>
    )
  }

  if (showStretchGate) {
    const startRun = (withWarmup) => {
      onComplete?.()
      const state = { ...(workoutHandoff?.state || {}), startAfterWarmup: withWarmup }
      navigate(withWarmup ? '/warmup' : '/run/active', { state })
    }
    return (
      <div className="forged-branded-screen" style={{ minHeight: '100vh', background: 'var(--bg-base)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 20, textAlign: 'center', maxWidth: 480, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        <div style={{ background: 'var(--bg-card)', borderRadius: 20, padding: 32, width: '100%' }}>
          <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)', marginBottom: 8 }}>Warm up first</p>
          <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 28 }}>
            Use a short dynamic warm-up before the run. Takes about 5 minutes.
          </p>
          <button
            onClick={() => startRun(true)}
            style={{ width: '100%', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, borderRadius: 14, padding: '18px', border: 'none', cursor: 'pointer', fontSize: 16, marginBottom: 12 }}
          >
            Start Warm-Up
          </button>
          <button
            onClick={() => startRun(false)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, padding: '8px 0' }}
          >
            Skip, start the run
          </button>
        </div>
      </div>
    )
  }

  if (adjustment) {
    const hasDrivers = drivers.length > 0
    const continueToWorkout = () => {
      if (workoutHandoff?.kind === 'run') {
        setShowStretchGate(true)
        return
      }
      onComplete?.()
      if (workoutHandoff?.route) {
        navigate(workoutHandoff.route, workoutHandoff.state ? { state: workoutHandoff.state } : undefined)
      } else {
        navigate('/')
      }
    }
    const actionLabel = workoutHandoff?.kind === 'run'
      ? 'Prepare to Run'
      : workoutHandoff?.kind === 'strength'
        ? 'Review Strength Workout'
        : 'View Today'
    return (
      <div className="forged-branded-screen" style={{ minHeight: '100vh', background: 'var(--bg-base)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 20, textAlign: 'center', maxWidth: 480, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        <p style={{ fontSize: 28, lineHeight: 1.15, fontWeight: 900, color: 'var(--text-primary)', maxWidth: 360, margin: 0 }}>{headline || adjustment}</p>
        {hasDrivers ? (
          <div style={{ width: '100%', maxWidth: 360 }}>
            <button
              onClick={() => setShowBreakdown(prev => !prev)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent)',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 800,
                padding: '4px 0',
              }}
            >
              {showBreakdown ? 'Hide breakdown' : 'See full breakdown'}
            </button>
            {showBreakdown && (
              <div style={{ marginTop: 10, background: 'var(--bg-card)', borderRadius: 16, padding: 16, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 14 }}>
                {drivers.map((driver, idx) => (
                  <div key={`${driver.label || 'driver'}-${idx}`}>
                    <p style={{ fontSize: 13, fontWeight: 900, color: 'var(--text-primary)', margin: '0 0 4px' }}>{driver.label}</p>
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>{driver.detail}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, maxWidth: 340, margin: 0 }}>
            No extra adjustment drivers today.
          </p>
        )}
        {todayPlan && (
          <div style={{ background: 'var(--bg-card)', borderRadius: 16, padding: 20, width: '100%', textAlign: 'left' }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>Today's Workout</p>
            <p style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 4, textTransform: 'capitalize' }}>
              {todayPlan.type || todayPlan.workout_type || todayPlan.recommendationType || 'Run'}
            </p>
            {(todayPlan.distance || todayPlan.distance_miles || todayPlan.suggestedDistance) && <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>{todayPlan.distance || todayPlan.distance_miles || todayPlan.suggestedDistance} miles</p>}
            {(todayPlan.pace || todayPlan.pace_target || todayPlan.suggestedPace) && <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>{todayPlan.pace || todayPlan.pace_target || todayPlan.suggestedPace}</p>}
            {(todayPlan.notes || todayPlan.description || todayPlan.reason) && <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>{todayPlan.notes || todayPlan.description || todayPlan.reason}</p>}
          </div>
        )}
        {!todayPlan && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, maxWidth: 340, margin: 0 }}>
            Check-in saved. No workout is scheduled, so Forged Hybrid will not send you into a warm-up with nothing to start.
          </p>
        )}
        <button onClick={continueToWorkout}
          style={{ background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, borderRadius: 14, padding: '18px 48px', border: 'none', cursor: 'pointer', fontSize: 16 }}>
          {actionLabel}
        </button>
      </div>
    )
  }

  const previewDrivers = (preview?.drivers || []).slice(0, 2)
  const previewCopy = legs == null || drive == null
    ? 'Pick your legs + drive to see today\'s plan'
    : preview?.headline || (previewError || preview ? 'Plan preview unavailable — submit to see your adjustment' : 'Pick your legs + drive to see today\'s plan')

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', padding: '24px 20px', paddingBottom: 100, maxWidth: 480, margin: '0 auto', boxSizing: 'border-box', width: '100%' }}>
      <h1 style={{ fontWeight: 900, fontSize: 26, color: 'var(--text-primary)', marginBottom: 4 }}>Morning Check-In</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 28 }}>3 taps — I'll adjust your plan around your day.</p>

      <ReadinessSegment
        title="How are your legs?"
        helper="Physical freshness"
        options={LEG_OPTIONS}
        value={legs}
        onChange={(nextLegs) => {
          setLegs(nextLegs)
          clearFieldError('legs')
        }}
        error={fieldErrors.legs}
        errorRef={legsErrorRef}
      />

      <ReadinessSegment
        title="How is your drive?"
        helper="Mental energy to train"
        options={DRIVE_OPTIONS}
        value={drive}
        onChange={(nextDrive) => {
          setDrive(nextDrive)
          clearFieldError('drive')
        }}
        error={fieldErrors.drive}
        errorRef={driveErrorRef}
      />

      <div
        style={{
          background: 'var(--bg-input)',
          borderLeft: '3px solid var(--accent)',
          borderRadius: 16,
          padding: 16,
          marginBottom: 24,
          minHeight: 96,
          boxSizing: 'border-box',
          opacity: previewLoading ? 0.72 : 1,
          transition: 'opacity 160ms ease',
        }}
      >
        <p style={{ fontSize: 11, fontWeight: 900, color: 'var(--accent)', letterSpacing: 1, textTransform: 'uppercase', margin: '0 0 8px' }}>Today</p>
        <p style={{ fontSize: 17, lineHeight: 1.35, fontWeight: 900, color: 'var(--text-primary)', margin: '0 0 12px' }}>
          {previewCopy}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, minHeight: 26 }}>
          {previewLoading ? (
            <>
              <span style={{ width: 92, height: 24, borderRadius: 999, background: 'var(--accent-dim)', opacity: 0.65 }} />
              <span style={{ width: 118, height: 24, borderRadius: 999, background: 'var(--accent-dim)', opacity: 0.45 }} />
            </>
          ) : previewDrivers.map((driver, idx) => (
            <span
              key={`${driver.label || driver}-${idx}`}
              style={{
                borderRadius: 999,
                background: 'var(--accent-dim)',
                color: 'var(--accent)',
                fontSize: 11,
                fontWeight: 900,
                padding: '6px 10px',
              }}
            >
              {driver.label || driver}
            </span>
          ))}
        </div>
      </div>

      <div ref={timeErrorRef} style={{ marginBottom: 24 }}>
        <p style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>How much time do you have to workout?</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {TIME_OPTIONS.map(t => (
            <button key={t.value} onClick={() => { setTimeAvailable(t.value); clearFieldError('time_available') }}
              style={{
                padding: '10px 16px', borderRadius: 12, border: `2px solid ${timeAvailable === t.value ? 'var(--accent)' : 'var(--border-subtle)'}`,
                background: timeAvailable === t.value ? 'var(--accent-dim)' : 'var(--bg-card)',
                color: timeAvailable === t.value ? 'var(--accent)' : 'var(--text-muted)',
                fontWeight: 700, fontSize: 14, cursor: 'pointer',
              }}>
              {t.label}
            </button>
          ))}
        </div>
        {fieldErrors.time_available && <p style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>{fieldErrors.time_available}</p>}
      </div>

      <div style={{ marginBottom: 32 }}>
        <p style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>Anything going on?</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {LIFE_FLAGS.map(f => (
            <button key={f.value} onClick={() => toggleFlag(f.value)}
              style={{
                padding: '10px 16px', borderRadius: 12, border: `2px solid ${lifeFlags.includes(f.value) ? 'var(--accent)' : 'var(--border-subtle)'}`,
                background: lifeFlags.includes(f.value) ? 'var(--accent-dim)' : 'var(--bg-card)',
                color: lifeFlags.includes(f.value) ? 'var(--accent)' : 'var(--text-muted)',
                fontWeight: 700, fontSize: 14, cursor: 'pointer',
              }}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {submitError && (
        <p role="alert" style={{ background: 'var(--bg-card)', border: '1px solid var(--danger)', borderRadius: 12, color: 'var(--danger)', fontSize: 13, fontWeight: 700, lineHeight: 1.4, padding: '12px 14px', margin: '0 0 16px' }}>
          {submitError}
        </p>
      )}

      <button onClick={submit} disabled={saving}
        style={{
          width: '100%', background: !saving ? 'var(--accent)' : 'var(--bg-input)',
          color: 'var(--on-accent)', fontWeight: 900, fontSize: 17, borderRadius: 16, padding: '18px', border: 'none', cursor: 'pointer',
          opacity: saving ? 0.6 : 1,
          marginBottom: 80,
        }}>
        {saving ? 'Adjusting your plan...' : 'Done'}
      </button>
    </div>
  )
}
