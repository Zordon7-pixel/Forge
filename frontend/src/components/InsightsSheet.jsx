import React, { useEffect, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, Brain, ChevronRight, Lock, Watch, AlertTriangle } from 'lucide-react'
import AgeGradedPerformanceCard from './AgeGradedPerformanceCard'
import { getToken } from '../lib/tokenStore'

function TrendChart({ data = [] }) {
  if (!data.length) return null
  const maxMiles = Math.max(...data.map(d => d.miles), 1)
  const w = 100, h = 40
  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - (d.miles / maxMiles) * h
    return `${x},${y}`
  }).join(' ')
  const areaPoints = `0,${h} ` + points + ` ${w},${h}`

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-16" preserveAspectRatio="none">
      <defs>
        <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.4"/>
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"/>
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill="url(#trendGrad)" />
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {data.map((d, i) => {
        const x = (i / (data.length - 1)) * w
        const y = h - (d.miles / maxMiles) * h
        return d.miles > 0 ? <circle key={i} cx={x} cy={y} r="1.5" fill="var(--accent)" /> : null
      })}
    </svg>
  )
}

function getRecommendationLabel(recommendation) {
  return recommendation
    ? String(recommendation.recommendationType || "today's session").replace('_', ' ')
    : "today's session"
}

export function ReadinessGauge({ score, onClick }) {
  const r = 28, cx = 36, cy = 36
  const circumference = 2 * Math.PI * r
  const dash = (score / 100) * circumference
  const color = score >= 75 ? '#22c55e' : score >= 50 ? 'var(--accent)' : '#ef4444'
  const label = score >= 80 ? 'Optimal' : score >= 60 ? 'Good' : score >= 40 ? 'Moderate' : 'Low'

  return (
    <div onClick={onClick} style={{ cursor: 'pointer' }} className="flex flex-col">
      <div className="flex items-center gap-4">
        <svg width="72" height="72" viewBox="0 0 72 72">
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border-subtle)" strokeWidth="5" />
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="5"
            strokeDasharray={`${dash} ${circumference}`}
            strokeLinecap="round"
            transform={`rotate(-90 ${cx} ${cy})`} />
          <text x={cx} y={cy+1} textAnchor="middle" dominantBaseline="middle"
            fontSize="13" fontWeight="bold" fill={color}>{score}</text>
        </svg>
        <div>
          <p className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>{label}</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Readiness</p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
            {score >= 75 ? 'Go hard today.' : score >= 50 ? 'Moderate effort.' : 'Take it easy today.'}
          </p>
        </div>
      </div>
      <p className="text-xs mt-2" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>Tap to see breakdown</p>
    </div>
  )
}

export function DailyCoachFlow({ checkedInToday, readiness, recommendation, onCheckIn, onStartWorkout, onReflect, onDetails }) {
  const recommendationLabel = recommendation
    ? getRecommendationLabel(recommendation)
    : "today's session"
  const steps = [
    { key: 'checkin', label: 'Check in', done: checkedInToday, action: onCheckIn },
    { key: 'train', label: recommendation ? recommendationLabel : 'train', done: false, action: onStartWorkout },
    { key: 'reflect', label: 'reflect', done: false, action: onReflect },
  ]

  return (
    <section className="rounded-2xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid rgba(234,179,8,0.42)' }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase" style={{ color: '#EAB308', letterSpacing: 0.8 }}>Today</p>
          <h2 className="mt-1 text-2xl font-black" style={{ color: 'var(--text-primary)' }}>
            {checkedInToday ? 'Train from the plan' : 'Start with readiness'}
          </h2>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            {readiness !== null ? `Readiness ${readiness}. ` : ''}
            {recommendation ? `${recommendationLabel}${Number(recommendation.suggestedDistance || 0) > 0 ? ` · ${recommendation.suggestedDistance} mi` : ''}` : 'Check in to unlock the next move.'}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <button
            onClick={checkedInToday ? onStartWorkout : onCheckIn}
            className="rounded-xl px-3 py-2 text-xs font-black"
            style={{ background: 'var(--accent)', color: '#000', border: 'none' }}
          >
            {checkedInToday ? 'Start' : 'Check in'}
          </button>
          <button
            onClick={onDetails}
            className="rounded-xl px-3 py-2 text-xs font-bold"
            style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
          >
            Details
          </button>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {steps.map((step, index) => (
          <button
            key={step.key}
            type="button"
            onClick={step.action}
            className="rounded-xl px-2 py-3 text-left"
            style={{ background: step.done ? 'rgba(34,197,94,0.12)' : 'var(--bg-input)', border: `1px solid ${step.done ? 'rgba(34,197,94,0.35)' : 'var(--border-subtle)'}` }}
          >
            <span className="text-[10px] font-bold" style={{ color: step.done ? '#22c55e' : 'var(--text-muted)' }}>{index + 1}</span>
            <p className="mt-1 text-xs font-semibold capitalize" style={{ color: 'var(--text-primary)' }}>{step.label}</p>
          </button>
        ))}
      </div>
    </section>
  )
}

export function WatchSyncWidget({ onSyncPayload }) {
  const [syncStatus, setSyncStatus] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [justSynced, setJustSynced] = useState(false)

  useEffect(() => {
    const token = getToken()
    if (!token) return
    const applyStatus = (data) => {
      setSyncStatus((prev) => {
        if (data && prev && data.synced_at !== prev?.synced_at) {
          setJustSynced(true)
          setTimeout(() => setJustSynced(false), 3000)
        }
        return data
      })
      onSyncPayload?.(data)
    }
    fetch('/api/watch-sync/status', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(applyStatus)
      .catch(() => {})

    const interval = setInterval(() => {
      fetch('/api/watch-sync/status', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : null)
        .then(applyStatus)
        .catch(() => {})
    }, 10000)
    return () => clearInterval(interval)
  }, [onSyncPayload])

  const watchBrand = syncStatus?.treadmill_brand || syncStatus?.watch_mode || null
  const hasData = syncStatus && (syncStatus.avg_heart_rate || syncStatus.distance_miles)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <style>{`
        @keyframes watchPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(234,179,8,0.4); } 50% { box-shadow: 0 0 0 8px rgba(234,179,8,0); } }
        @keyframes syncFlash { 0% { background: rgba(34,197,94,0.3); } 100% { background: transparent; } }
      `}</style>
      <button
        onClick={() => {
          setSyncing(true)
          setTimeout(() => setSyncing(false), 1500)
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: hasData ? 'rgba(234,179,8,0.1)' : 'var(--bg-input)',
          border: `1px solid ${hasData ? 'rgba(234,179,8,0.4)' : 'var(--border-subtle)'}`,
          borderRadius: 10, padding: '6px 12px', cursor: 'pointer',
          animation: syncing ? 'watchPulse 1s ease-in-out infinite' : 'none',
          transition: 'all 0.3s ease',
          ...(justSynced ? { animation: 'syncFlash 1s ease forwards' } : {}),
        }}
      >
        <Watch size={14} color={hasData ? '#EAB308' : 'var(--text-muted)'} />
        <div style={{ textAlign: 'left' }}>
          <p style={{ fontSize: 9, color: 'var(--text-muted)', margin: 0, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            {watchBrand || 'Watch'}
          </p>
          <p style={{ fontSize: 11, fontWeight: 700, color: hasData ? '#EAB308' : 'var(--text-muted)', margin: 0 }}>
            {justSynced ? 'Synced!' : hasData ? `HR ${syncStatus.avg_heart_rate || '--'} bpm` : 'No data'}
          </p>
        </div>
        {hasData && (
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', animation: 'watchPulse 2s ease infinite' }} />
        )}
      </button>
    </div>
  )
}

export function TodayDetailSheet({
  open,
  onClose,
  checkedInToday,
  readiness,
  readinessBreakdown,
  recommendation,
  checkinData,
  dailySteps,
  dailyStepsSource,
  activeInjury,
  watchSyncNotice,
  compliance,
  onCheckIn,
  onStartWorkout,
  onWarmup,
  onReflect,
  onOpenReadiness,
}) {
  if (!open) return null
  const recommendationLabel = recommendation ? getRecommendationLabel(recommendation) : null
  const topFactors = (readinessBreakdown || []).filter((item) => item.label !== 'Base score').slice(0, 2)
  const planSignals = [
    !checkedInToday ? 'Today starts with check-in data so Forge can adjust effort before you train.' : null,
    activeInjury ? `Recovery mode is active for ${activeInjury.body_part || 'your injury'}, so workouts are softened until return.` : null,
    watchSyncNotice ? 'A new watch activity was synced and may change load, recovery, and the next workout.' : null,
    compliance && compliance.completed < compliance.planned ? 'Missed planned sessions this week can shift the next run toward base or recovery work.' : null,
    checkinData?.sleep_hours ? `${checkinData.sleep_hours}h sleep is included in today's readiness.` : null,
    dailySteps !== null ? `${Number(dailySteps).toLocaleString()} steps${dailyStepsSource === 'watch' ? ' from watch sync' : ''} are part of the daily context.` : null,
  ].filter(Boolean)

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{ background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', padding: 24, width: '100%', maxHeight: '82vh', overflowY: 'auto' }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase" style={{ color: '#EAB308', letterSpacing: 0.8 }}>Today</p>
            <h2 className="mt-1 text-2xl font-black" style={{ color: 'var(--text-primary)' }}>
              {checkedInToday ? 'Plan locked for today' : 'Check in before training'}
            </h2>
          </div>
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
            Close
          </button>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Readiness</p>
            <p className="mt-1 text-xl font-black" style={{ color: readiness === null ? 'var(--text-muted)' : 'var(--text-primary)' }}>
              {readiness === null ? '--' : readiness}
            </p>
          </div>
          <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Workout</p>
            <p className="mt-1 text-sm font-bold capitalize" style={{ color: 'var(--text-primary)' }}>
              {recommendationLabel || 'After check-in'}
            </p>
            {recommendation && Number(recommendation.suggestedDistance || 0) > 0 && (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{recommendation.suggestedDistance} mi</p>
            )}
          </div>
        </div>

        <section className="mt-5">
          <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>Why this plan</p>
          <div className="mt-2 space-y-2">
            {recommendation?.reason && (
              <p className="rounded-xl p-3 text-sm" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
                {recommendation.reason}
              </p>
            )}
            {topFactors.length > 0 ? topFactors.map((factor) => (
              <p key={factor.label} className="rounded-xl p-3 text-sm" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
                <strong style={{ color: 'var(--text-primary)' }}>{factor.label}:</strong> {factor.reason}
              </p>
            )) : (
              <p className="rounded-xl p-3 text-sm" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
                Complete check-in and sync a watch to unlock the readiness explanation.
              </p>
            )}
          </div>
        </section>

        <section className="mt-5">
          <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>Actions</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button onClick={onCheckIn} className="rounded-xl px-3 py-3 text-sm font-bold" style={{ background: checkedInToday ? 'var(--bg-input)' : 'var(--accent)', color: checkedInToday ? 'var(--text-primary)' : '#000' }}>
              {checkedInToday ? 'Edit check-in' : 'Check in'}
            </button>
            <button onClick={onStartWorkout} className="rounded-xl px-3 py-3 text-sm font-bold" style={{ background: 'var(--accent)', color: '#000' }}>
              Start/log
            </button>
            <button onClick={onWarmup} className="rounded-xl px-3 py-3 text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
              Warm-up
            </button>
            <button onClick={onReflect} className="rounded-xl px-3 py-3 text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
              Reflect
            </button>
          </div>
          {readiness !== null && (
            <button onClick={onOpenReadiness} className="mt-2 w-full rounded-xl px-3 py-3 text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
              Readiness breakdown
            </button>
          )}
        </section>

        <section className="mt-5">
          <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>Adjustment history</p>
          <div className="mt-2 space-y-2">
            {(planSignals.length ? planSignals : ['Forge has not detected any missed-session, recovery-mode, or new sync signals today.']).map((signal) => (
              <p key={signal} className="rounded-xl p-3 text-sm" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
                {signal}
              </p>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

export function RecentActivityCard({ recentActivity, navigate, fmt, fmtDuration, t }) {
  return (
    <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
      <h3 className="text-base font-bold mb-3" style={{ color: 'var(--text-primary)', borderBottom: '1px solid rgba(234,179,8,0.45)', paddingBottom: 6 }}>Recent Activity</h3>
      <div className="space-y-3">
        {recentActivity.map(item => {
          if (item._type === 'run') {
            return (
              <div key={item.id} onClick={() => navigate(`/history?runId=${item.id}`)} className="rounded-xl p-3 border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', borderLeft: '4px solid #EAB308', cursor: 'pointer' }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>Run</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {new Date(item.date || item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                </div>
                <div className="flex gap-4 mt-1">
                  <div><p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{fmt.distance(Number(item.distance_miles || 0), 2)}</p></div>
                  <div><p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{fmt.pace(item.duration_seconds / item.distance_miles)}</p></div>
                  <div><p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{fmtDuration(item.duration_seconds)}</p></div>
                  {item.calories > 0 && <div><p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{item.calories} cal</p></div>}
                </div>
              </div>
            )
          }

          if (item._type === 'other') {
            return (
              <div key={item.id} className="rounded-xl p-3 border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)' }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(234,179,8,0.2)', color: 'var(--accent)' }}>Other Activity</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{new Date(item.synced_at || item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                </div>
                <p className="text-sm font-bold mt-1" style={{ color: 'var(--text-primary)' }}>{item.activity_name || item.activity_type || 'Synced activity'}</p>
              </div>
            )
          }

          return (
            <div key={item.id} onClick={() => navigate(`/history?workoutId=${item.id}`)} className="rounded-xl p-3 border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', borderLeft: '4px solid #ffffff', cursor: 'pointer' }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(139,92,246,0.15)', color: '#a78bfa' }}>Lift</span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {new Date(item.date || item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </div>
              <p className="text-sm font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                {item.exercise_name || (Array.isArray(item.muscle_groups) ? item.muscle_groups.join(', ') : 'Workout')}
              </p>
              {item.sets && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{item.sets} sets · {item.reps} reps · {item.weight_lbs} lbs</p>}
            </div>
          )
        })}
        {recentActivity.length === 0 && (
          <p className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>{t('dashboard.noActivity')}</p>
        )}
      </div>
    </section>
  )
}

export function CalendarDayDetailSheet({ selectedCalendarDay, onClose, fmtDuration }) {
  if (!selectedCalendarDay) return null

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', padding: 24, width: '100%', maxHeight: '60vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {new Date(selectedCalendarDay.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
            <p style={{ fontSize: 20, fontWeight: 900, color: 'var(--text-primary)' }}>
              {selectedCalendarDay.hasRun || selectedCalendarDay.hasLift ? 'Active Day' : 'Rest Day'}
            </p>
          </div>
          <button onClick={onClose}
            style={{ background: 'var(--bg-input)', border: 'none', borderRadius: 10, padding: '8px 14px', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>
            Close
          </button>
        </div>

        {selectedCalendarDay.run && (
          <div style={{ background: 'var(--bg-base)', borderRadius: 14, padding: 16, marginBottom: 12 }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>Run</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)' }}>
                  {Number(selectedCalendarDay.run.distance || 0).toFixed(2)}
                </p>
                <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>miles</p>
              </div>
              {selectedCalendarDay.run.duration > 0 && (
                <div>
                  <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)' }}>
                    {fmtDuration(selectedCalendarDay.run.duration)}
                  </p>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>duration</p>
                </div>
              )}
              {selectedCalendarDay.run.distance > 0 && selectedCalendarDay.run.duration > 0 && (
                <div>
                  <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)' }}>
                    {(() => { const ppm = selectedCalendarDay.run.duration / selectedCalendarDay.run.distance; return `${Math.floor(ppm/60)}:${String(Math.round(ppm%60)).padStart(2,'0')}`})()}
                  </p>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>avg pace /mi</p>
                </div>
              )}
              {selectedCalendarDay.run.surface && (
                <div>
                  <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'capitalize' }}>{selectedCalendarDay.run.surface}</p>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>surface</p>
                </div>
              )}
            </div>
            {selectedCalendarDay.run.notes && (
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
                {selectedCalendarDay.run.notes}
              </p>
            )}
          </div>
        )}

        {selectedCalendarDay.lifts && (
          <div style={{ background: 'var(--bg-base)', borderRadius: 14, padding: 16, marginBottom: 12 }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>Strength</p>
            <p style={{ fontSize: 20, fontWeight: 900, color: 'var(--text-primary)' }}>{selectedCalendarDay.lifts} workout session{selectedCalendarDay.lifts > 1 ? 's' : ''}</p>
          </div>
        )}

        {!selectedCalendarDay.hasRun && !selectedCalendarDay.hasLift && (
          <div style={{ background: 'var(--bg-base)', borderRadius: 14, padding: 20, textAlign: 'center' }}>
            <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Rest day</p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              {selectedCalendarDay.isToday ? "No activity logged yet today." : "Recovery is part of training. Rest days make you stronger."}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

export function ReadinessBreakdownModal({ open, onClose, readiness, readinessBreakdown }) {
  if (!open) return null

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', padding: 24, width: '100%', maxHeight: '70vh', overflowY: 'auto' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Readiness</p>
            <p style={{ fontSize: 28, fontWeight: 900, color: 'var(--accent)' }}>{readiness} <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--text-muted)' }}>/ 100</span></p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{readiness >= 80 ? 'Go hard today.' : readiness >= 60 ? 'Moderate effort — push but listen to your body.' : readiness >= 40 ? 'Take it easy — a recovery run or rest day is smart.' : 'Rest today. Your body is telling you something.'}</p>
          </div>
          <button onClick={onClose} style={{ background: 'var(--bg-input)', border: 'none', borderRadius: 10, padding: '8px 14px', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>Close</button>
        </div>

        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 }}>Score Breakdown</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {readinessBreakdown.map((f, i) => (
            <div key={i} style={{ background: 'var(--bg-base)', borderRadius: 12, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{f.label}</p>
                <p style={{ fontSize: 13, fontWeight: 700, color: f.delta > 0 ? '#22c55e' : f.delta < 0 ? '#ef4444' : 'var(--text-muted)' }}>
                  {f.delta > 0 ? `+${f.delta}` : f.delta < 0 ? `${f.delta}` : `${f.value}`}
                </p>
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{f.reason}</p>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 20, padding: 14, background: 'var(--bg-base)', borderRadius: 12, borderLeft: '3px solid var(--accent)' }}>
          <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', marginBottom: 6 }}>How to improve your score</p>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Log runs consistently to build your streak. Keep weekly mileage within 10–20% of your average. Import watch data for HRV and sleep when available — that unlocks a much more accurate score.
          </p>
        </div>
      </div>
    </div>
  )
}

export default function InsightsSheet({
  open,
  onClose,
  watchSyncWidget,
  weeklyRecap,
  navigate,
  ageGradedPerformance,
  showLoadWarning,
  loadAnalysis,
  onDismissLoadWarning,
  nextRace,
  compliance,
  showComplianceDetails,
  setShowComplianceDetails,
  complianceColor,
  milestones,
  setMilestones,
  healthSync,
  proLoading,
  isPro,
  healthSyncNotice,
  stats,
  onSelectCalendarDay,
  thisWeekLabel,
  period,
  setPeriod,
  periodLabels,
  milesCount,
  runsCount,
  periodStats,
  weeklyCalories,
  fmt,
  fmtHours,
  warning,
  shoeAlerts,
}) {
  if (!open) return null

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{ background: 'var(--bg-base)', borderRadius: '20px 20px 0 0', padding: 16, width: '100%', maxHeight: '82vh', overflowY: 'auto' }}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase" style={{ color: '#EAB308', letterSpacing: 0.8 }}>Forge</p>
            <h2 className="mt-1 text-2xl font-black" style={{ color: 'var(--text-primary)' }}>More insights</h2>
          </div>
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
            Close
          </button>
        </div>

        <div className="space-y-4">
          {watchSyncWidget}

          {weeklyRecap && (
            <button
              onClick={() => navigate('/recap/weekly')}
              className="w-full rounded-xl p-4"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', textAlign: 'left' }}
            >
              <div className="flex items-center justify-between">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Brain size={16} color="#EAB308" />
                  <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>Weekly AI Recap</p>
                </div>
                <ChevronRight size={16} color="var(--text-muted)" />
              </div>
              <p className="text-sm font-semibold mt-2" style={{ color: 'var(--text-primary)' }}>
                {Number(weeklyRecap.totalMiles || 0).toFixed(1)} mi · {weeklyRecap.totalRuns || 0} runs · {weeklyRecap.avgPace ? `${weeklyRecap.avgPace}/mi` : 'Pace n/a'}
              </p>
              {weeklyRecap.injuryRiskFlag && (
                <p className="text-xs mt-1" style={{ color: '#F97316' }}>{weeklyRecap.injuryRiskReason || 'Elevated injury risk this week'}</p>
              )}
            </button>
          )}

          {ageGradedPerformance && (
            <AgeGradedPerformanceCard
              data={ageGradedPerformance}
              onOpenProfile={() => navigate('/profile')}
            />
          )}

          {showLoadWarning && (
            <div className="rounded-xl p-3" style={{
              background: loadAnalysis.loadStatus === 'danger' ? 'rgba(239,68,68,0.12)' : loadAnalysis.loadStatus === 'high' ? 'rgba(249,115,22,0.12)' : 'rgba(234,179,8,0.12)',
              border: `1px solid ${loadAnalysis.loadStatus === 'danger' ? 'rgba(239,68,68,0.35)' : loadAnalysis.loadStatus === 'high' ? 'rgba(249,115,22,0.35)' : 'rgba(234,179,8,0.35)'}`
            }}>
              <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-primary)' }}>{loadAnalysis.loadStatus} load</p>
              <p className="text-sm mt-1" style={{ color: 'var(--text-primary)' }}>{loadAnalysis.warning || loadAnalysis.recommendation}</p>
              <div className="mt-2 flex gap-2">
                <button className="rounded-lg px-3 py-1.5 text-xs font-bold" style={{ background: 'var(--accent)', color: '#000' }} onClick={() => navigate('/plan', { state: { suggestEasyDay: true } })}>Take Easy Day</button>
                <button className="rounded-lg px-3 py-1.5 text-xs" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }} onClick={onDismissLoadWarning}>OK</button>
              </div>
            </div>
          )}

          {nextRace && (() => { const days = Math.ceil((new Date(`${nextRace.race_date}T12:00:00`).getTime() - Date.now()) / 86400000); return days > 0 && days <= 60 ? (
            <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Next Race</p>
              <p className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>{nextRace.race_name}</p>
              <p className="text-sm" style={{ color: 'var(--accent)' }}>{days} days to go</p>
            </div>
          ) : null })()}

          {compliance && (
            <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }} onClick={() => setShowComplianceDetails(!showComplianceDetails)}>
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>This Week: {compliance.completed}/{compliance.planned} sessions — {compliance.score}%</p>
              <div className="w-full h-2 rounded-full mt-2" style={{ background: 'var(--bg-input)' }}>
                <div className="h-2 rounded-full" style={{ width: `${compliance.score}%`, background: complianceColor }} />
              </div>
              {showComplianceDetails && (
                <div className="mt-3 space-y-1">
                  {(compliance.sessions || []).map((s, i) => (
                    <p key={i} className="text-xs" style={{ color: s.completed ? '#22c55e' : '#ef4444' }}>{s.day}: {s.type} {s.completed ? 'hit' : 'missed'}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {milestones.length > 0 && (
            <div className="space-y-2">
              {milestones.map((m) => (
                <div key={m.key} className="rounded-xl p-3 flex items-center justify-between" style={{ background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.3)' }}>
                  <div>
                    <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{m.title}</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{m.description}</p>
                  </div>
                  <button onClick={() => setMilestones(prev => prev.filter(x => x.key !== m.key))} className="text-xs" style={{ color: 'var(--text-muted)' }}>Dismiss</button>
                </div>
              ))}
            </div>
          )}

          <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-bold uppercase tracking-wide" style={{ color: '#EAB308' }}>Health Sync</p>
              {healthSync.loading ? (
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Syncing...</p>
              ) : (
                <button
                  type="button"
                  onClick={() => navigate('/health')}
                  className="rounded-lg px-3 py-1.5 text-xs font-bold"
                  style={{ background: 'var(--bg-input)', color: '#EAB308', border: '1px solid var(--border-subtle)' }}
                >
                  View all
                </button>
              )}
            </div>

            {!proLoading && !isPro && (
              <div>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Apple Health sync is available on the Pro tier.</p>
                <button
                  onClick={() => navigate('/upgrade')}
                  className="mt-3 rounded-lg px-3 py-2 text-xs font-bold"
                  style={{ background: '#EAB308', color: '#000', border: 'none', cursor: 'pointer' }}
                >
                  Upgrade to Pro
                </button>
              </div>
            )}

            {isPro && !healthSync.loading && !healthSync.available && (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {healthSync.reason || 'Apple Health is not available right now.'}
              </p>
            )}

            {isPro && healthSync.metrics && (
              <div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Total miles this week</p>
                    <p className="text-lg font-black" style={{ color: 'var(--text-primary)' }}>{healthSync.metrics.totalMilesThisWeek.toFixed(2)}</p>
                  </div>
                  <div className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Avg heart rate from last run</p>
                    <p className="text-lg font-black" style={{ color: 'var(--text-primary)' }}>
                      {healthSync.metrics.avgHeartRateFromLastRun ? `${healthSync.metrics.avgHeartRateFromLastRun} bpm` : '--'}
                    </p>
                  </div>
                  <div className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Calories burned today</p>
                    <p className="text-lg font-black" style={{ color: 'var(--text-primary)' }}>
                      {Number(healthSync.metrics.caloriesBurnedToday || 0).toLocaleString()}
                    </p>
                  </div>
                  <div className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Steps today</p>
                    <p className="text-lg font-black" style={{ color: 'var(--text-primary)' }}>
                      {Number(healthSync.metrics.stepsToday || 0).toLocaleString()}
                    </p>
                  </div>
                  <div className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Sleep last night</p>
                    <p className="text-lg font-black" style={{ color: 'var(--text-primary)' }}>
                      {healthSync.metrics.sleepHoursLastNight ? `${Number(healthSync.metrics.sleepHoursLastNight).toFixed(1)}h` : '--'}
                    </p>
                  </div>
                  <div className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Resting HR</p>
                    <p className="text-lg font-black" style={{ color: 'var(--text-primary)' }}>
                      {healthSync.metrics.restingHeartRate ? `${healthSync.metrics.restingHeartRate} bpm` : '--'}
                    </p>
                  </div>
                  <div className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>HRV</p>
                    <p className="text-lg font-black" style={{ color: 'var(--text-primary)' }}>
                      {healthSync.metrics.heartRateVariabilityMs ? `${healthSync.metrics.heartRateVariabilityMs} ms` : '--'}
                    </p>
                  </div>
                  <div className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Active minutes</p>
                    <p className="text-lg font-black" style={{ color: 'var(--text-primary)' }}>
                      {Number(healthSync.metrics.activeMinutesThisWeek || 0).toLocaleString()}
                    </p>
                  </div>
                  <div className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Workouts this week</p>
                    <p className="text-lg font-black" style={{ color: 'var(--text-primary)' }}>
                      {Number(healthSync.metrics.workoutCountThisWeek || 0).toLocaleString()}
                    </p>
                  </div>
                  <div className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Last workout</p>
                    <p className="text-sm font-black capitalize" style={{ color: 'var(--text-primary)' }}>
                      {healthSync.metrics.lastWorkoutType || '--'}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {healthSync.metrics.lastWorkoutDurationSeconds ? `${Math.round(Number(healthSync.metrics.lastWorkoutDurationSeconds) / 60)} min` : ''}
                      {healthSync.metrics.lastWorkoutCalories ? ` · ${healthSync.metrics.lastWorkoutCalories} cal` : ''}
                    </p>
                  </div>
                </div>
                {healthSyncNotice && (
                  <p className="mt-3 text-xs" style={{ color: '#F97316' }}>{healthSyncNotice}</p>
                )}
              </div>
            )}
          </section>

          {stats?.calendarDays && (
            <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
              <p className="text-xs font-medium mb-3" style={{ color: 'var(--text-muted)' }}>{thisWeekLabel}</p>
              <div className="grid grid-cols-7 gap-1">
                {stats.calendarDays.map((day) => (
                  <div key={day.date} className="flex flex-col items-center gap-1"
                    onClick={() => onSelectCalendarDay(day)}
                    style={{ cursor: 'pointer' }}
                  >
                    <span className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>{day.day}</span>
                    <div className="w-8 h-8 rounded-full flex items-center justify-center border"
                      style={{
                        background: day.hasRun || day.hasLift ? 'var(--accent)' : 'var(--bg-input)',
                        borderColor: day.isToday ? 'var(--accent)' : 'transparent',
                        borderWidth: day.isToday ? 2 : 1
                      }}>
                      {day.hasRun && day.hasLift ? (
                        <div className="flex items-center gap-1">
                          <span className="inline-block h-2 w-2 rounded-full" style={{ background: '#0f1117' }} aria-label="Run logged" />
                          <span className="inline-block h-2 w-2 rounded-full" style={{ background: '#F97316' }} aria-label="Lift logged" />
                        </div>
                      ) : day.hasRun ? (
                        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#0f1117' }} aria-label="Run logged" />
                      ) : day.hasLift ? (
                        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#F97316' }} aria-label="Lift logged" />
                      ) : (
                        <span className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.4 }}>·</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ position: 'relative' }}>
            <div style={{ filter: !proLoading && !isPro ? 'blur(4px)' : 'none', pointerEvents: !proLoading && !isPro ? 'none' : 'auto' }}>
              <div className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-card)' }}>
                <div className="flex gap-2">
                  {[
                    { key: 'day',   label: 'D'   },
                    { key: 'week',  label: 'W'   },
                    { key: 'month', label: 'M'   },
                    { key: 'all', label: 'All' },
                  ].map(({ key, label }) => (
                    <button key={key} onClick={() => setPeriod(key)}
                      className="px-4 py-1.5 rounded-full text-xs font-semibold transition-all"
                      style={period === key
                        ? { background: 'var(--accent)', color: '#000' }
                        : { background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>
                      {label}
                    </button>
                  ))}
                </div>

                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{periodLabels[period]}</p>

                <div>
                  <p className="text-5xl font-black tabular-nums" style={{ color: 'var(--text-primary)' }}>
                    {fmt.distanceValue((milesCount / 10)).toFixed(1)}
                  </p>
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{fmt.distanceLabel.charAt(0).toUpperCase() + fmt.distanceLabel.slice(1)}s</p>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  {[
                    {label:'Runs', value:runsCount},
                    {label:'Time', value:fmtHours(periodStats.seconds)},
                    {label:'Cal', value: period === 'week' ? weeklyCalories.toLocaleString() : (periodStats.calories || 0).toLocaleString()},
                  ].map((s, i) => {
                    const improving = i % 2 === 0
                    return <div key={s.label} className="rounded-lg p-2" style={{ border: '1px solid var(--border-subtle)' }}><p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{s.value}</p><p className="text-xs flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>{s.label}{improving ? <ArrowUpRight size={12} color="#22c55e"/> : <ArrowDownRight size={12} color="#ef4444"/>}</p></div>
                  })}
                </div>
              </div>

              {stats?.weeklyTrend && stats.weeklyTrend.some(w => w.miles > 0) && (
                <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Past 12 Weeks</p>
                    <p className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>
                      {fmt.distance(stats.weeklyTrend[stats.weeklyTrend.length - 1]?.miles, 1)} last week
                    </p>
                  </div>
                  <TrendChart data={stats.weeklyTrend} />
                  <div className="flex justify-between mt-1">
                    <span className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>
                      {new Date(stats.weeklyTrend[0]?.week).toLocaleDateString('en-US', { month: 'short' })}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>Now</span>
                  </div>
                </div>
              )}
            </div>
            {!proLoading && !isPro && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <div
                  className="rounded-2xl p-4"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', textAlign: 'center', maxWidth: 300 }}
                >
                  <Lock size={24} color="#EAB308" style={{ margin: '0 auto 8px' }} />
                  <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Advanced analytics is Pro-only</p>
                  <button
                    onClick={() => navigate('/upgrade')}
                    className="mt-3 rounded-lg px-3 py-2 text-xs font-bold"
                    style={{ background: '#EAB308', color: '#000', border: 'none', cursor: 'pointer' }}
                  >
                    Upgrade to Pro
                  </button>
                </div>
              </div>
            )}
          </div>

          {warning && (
            <div className="rounded-xl border p-3 text-sm" style={{ borderColor: 'rgba(234,179,8,0.3)', background: 'rgba(234,179,8,0.08)', color: 'var(--accent)' }}>
              Heavy legs detected — consider a rest day or easy run today
            </div>
          )}

          {shoeAlerts.map(shoe => (
            <div key={shoe.id} style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 12, padding: '10px 14px' }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: '#ef4444', margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertTriangle size={14} /> Your {shoe.nickname || `${shoe.brand} ${shoe.model}`} has {Number(shoe.total_miles || 0).toFixed(0)} miles — time to replace soon
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0' }}>{shoe.total_miles} of 500 miles</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
