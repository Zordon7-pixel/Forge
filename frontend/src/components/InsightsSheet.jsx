import React, { useEffect, useState } from 'react'
import { Activity, ArrowDownRight, ArrowUpRight, Brain, ChevronRight, Lock, Watch, AlertTriangle, Footprints, Dumbbell, CheckCircle2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import AgeGradedPerformanceCard from './AgeGradedPerformanceCard'
import { getToken } from '../lib/tokenStore'
import AiGuidanceNote from './AiGuidanceNote'
import ExerciseGuideAction from './ExerciseGuideAction'
import { activityLabel, isRunningActivity } from '../lib/activityType'
import { finiteReadinessScore, resolveReadiness } from '../lib/truthConsistency'
import { resolveTodayPlanAccess, resolveTodayWorkoutLabel } from '../lib/todayPlanAccess'
import { workoutActivityTitle } from '../lib/recentActivity'

function activityDateLabel(value) {
  if (!value) return '--'
  const raw = String(value)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00`) : new Date(raw)
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

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

function getPhaseLabel(phase, t) {
  if (phase === 'warmup') return t('today.phaseWarmup')
  if (phase === 'cooldown') return t('today.phaseCooldown')
  return t('today.phaseMain')
}

function formatPlanDuration(minutes, isEstimated) {
  const value = Number(minutes || 0)
  if (!(value > 0)) return ''
  return `${isEstimated ? '~' : ''}${Math.round(value)} min${isEstimated ? ' · estimate' : ''}`
}

function BlockRow({ block, t }) {
  if (!block) return null
  if (typeof block === 'string') {
    return (
      <div className="rounded-xl p-3 text-sm" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
        {block}
      </div>
    )
  }
  const phase = block.phase || 'main'
  const metric = block.durationMinutes
    ? `${block.durationMinutes} min`
    : block.distanceMiles
      ? `${block.distanceMiles} mi`
      : ''
  const pace = block.paceTarget ? ` @ ${block.paceTarget}` : ''
  const summary = `${metric}${pace}${metric || pace ? ' — ' : ''}${block.description || ''}`
  const isMain = phase === 'main'

  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center gap-2">
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-black uppercase"
          style={{
            background: isMain ? 'var(--accent)' : 'rgba(156,163,175,0.14)',
            color: isMain ? '#000' : 'var(--text-muted)',
          }}
        >
          {getPhaseLabel(phase, t)}
        </span>
        <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{block.label}</p>
      </div>
      {summary && <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{summary}</p>}
    </div>
  )
}

function calendarSessionKind(session) {
  return String(session?.kind || session?.type || session?.workout_type || '').toLowerCase() === 'lift' || /strength|lift/.test(String(session?.type || session?.workout_type || '').toLowerCase())
    ? 'lift'
    : 'run'
}

function calendarSessionTitle(session) {
  const kind = calendarSessionKind(session)
  return session?.title || session?.label || session?.workout_name || (kind === 'lift' ? 'Strength workout' : 'Run workout')
}

function calendarSessionMetrics(session) {
  if (!session) return []
  const kind = calendarSessionKind(session)
  if (kind === 'lift') {
    return [session.focus].filter(Boolean)
  }
  const distance = Number(session.distance_miles || session.distance || 0)
  const duration = Number(session.duration_min || session.durationMinutes || session.duration_minutes || 0)
  return [
    distance > 0 ? `${distance} mi` : '',
    duration > 0 ? `${Math.round(duration)} min` : '',
    session.pace_target || session.pace || session.target_pace || '',
    session.hrZone?.zoneLabel || session.target_zone || '',
  ].filter(Boolean)
}

function sessionStructure(session) {
  if (Array.isArray(session?.structure)) return session.structure
  if (Array.isArray(session?.steps)) return session.steps
  return []
}

function sessionExercises(session) {
  if (Array.isArray(session?.main)) return session.main
  if (Array.isArray(session?.exercises)) return session.exercises
  return []
}

function calendarSessionSupportsRoute(session) {
  if (calendarSessionKind(session) !== 'run') return false
  const type = String(session?.type || session?.workout_type || session?.prescription?.workout_type || '').toLowerCase()
  const distance = Number(session?.distance_miles || session?.distance || session?.prescription?.distance_miles || 0)
  return distance > 0 && !/treadmill|indoor|track/.test(type)
}

function TodayCalendarSession({ session, onStartRun, onStartLift, onPlanRoute, t }) {
  const kind = calendarSessionKind(session)
  const metrics = calendarSessionMetrics(session)
  const structure = sessionStructure(session)
  const exercises = sessionExercises(session)
  const start = kind === 'lift' ? onStartLift : onStartRun
  const Icon = kind === 'lift' ? Dumbbell : Footprints

  return (
    <article className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-black" style={{ color: 'var(--text-primary)' }}>
            <Icon size={16} color={kind === 'lift' ? 'var(--warning)' : 'var(--accent)'} />
            <span className="break-words">{calendarSessionTitle(session)}</span>
          </p>
          {metrics.length > 0 && <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{metrics.join(' · ')}</p>}
          {session?.description && <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{session.description}</p>}
        </div>
        {session?.completed && (
          <span className="flex shrink-0 items-center gap-1 text-[10px] font-black uppercase" style={{ color: 'var(--success)' }}>
            <CheckCircle2 size={14} /> Done
          </span>
        )}
      </div>

      {structure.length > 0 && (
        <div className="mt-3 space-y-2">
          {structure.map((block, index) => (
            <BlockRow key={`session-${session?.id || kind}-${index}`} block={block} t={t} />
          ))}
        </div>
      )}

      {exercises.length > 0 && (
        <div className="mt-3 space-y-2">
          {exercises.map((exercise, index) => {
            const name = exercise?.name || exercise?.exercise || `Exercise ${index + 1}`
            const prescription = [
              exercise?.sets && exercise?.reps ? `${exercise.sets} x ${exercise.reps}` : exercise?.sets ? `${exercise.sets} sets` : exercise?.reps || '',
              exercise?.rest ? `${exercise.rest} rest` : '',
            ].filter(Boolean).join(' · ')
            return (
              <div key={`${name}-${index}`} className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{name}</p>
                {prescription && <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>{prescription}</p>}
                <div className="mt-2">
                  <ExerciseGuideAction exercise={exercise} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {!session?.completed && (typeof start === 'function' || (calendarSessionSupportsRoute(session) && typeof onPlanRoute === 'function')) && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {typeof start === 'function' && (
            <button type="button" onClick={() => start(session)} className="pressable w-full rounded-lg px-3 py-2 text-sm font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
              {kind === 'lift' ? 'Start lift' : 'Start run'}
            </button>
          )}
          {calendarSessionSupportsRoute(session) && typeof onPlanRoute === 'function' && (
            <button type="button" onClick={() => onPlanRoute(session)} className="pressable w-full rounded-lg px-3 py-2 text-sm font-black" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
              Map route
            </button>
          )}
        </div>
      )}
    </article>
  )
}

export function ReadinessGauge({ score, onClick }) {
  const r = 28, cx = 36, cy = 36
  const circumference = 2 * Math.PI * r
  const readinessScore = finiteReadinessScore(score)
  const available = readinessScore !== null
  const dash = available ? (readinessScore / 100) * circumference : 0
  const color = !available ? 'var(--text-muted)' : readinessScore >= 75 ? 'var(--success)' : readinessScore >= 50 ? 'var(--accent)' : 'var(--danger)'
  const label = !available ? 'Unavailable' : readinessScore >= 80 ? 'Optimal' : readinessScore >= 60 ? 'Good' : readinessScore >= 40 ? 'Moderate' : 'Low'

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
            className="stat-num" fontSize="13" fontWeight="900" fill={color}>{available ? readinessScore : '--'}</text>
        </svg>
        <div>
          <p className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>{label}</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Readiness</p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
            {!available ? 'Sync Health data for a score.' : readinessScore >= 75 ? 'Go hard today.' : readinessScore >= 50 ? 'Moderate effort.' : 'Take it easy today.'}
          </p>
        </div>
      </div>
      <p className="text-xs mt-2" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>Tap to see breakdown</p>
    </div>
  )
}

export function DailyCoachFlow({ checkedInToday, readinessData, recommendation, execution, hasRunRecordedToday = false, onCheckIn, onStartWorkout, onStartUnplannedRun, onDetails }) {
  const readiness = resolveReadiness(readinessData)
  const isPlannedRestDay = execution?.isPlannedRest === true || execution?.restSource === 'planned'
  const isRestDay = isPlannedRestDay || recommendation?.recommendationType === 'rest' || recommendation?.type === 'rest'
  const recommendationLabel = recommendation
    ? getRecommendationLabel(recommendation)
    : "today's plan"
  const calendarSessions = execution?.hasDay && Array.isArray(execution.sessions) ? execution.sessions : []
  const pendingCalendarSessions = calendarSessions.filter((session) => session?.completed !== true)
  const allScheduledComplete = calendarSessions.length > 0 && pendingCalendarSessions.length === 0
  const planAccess = resolveTodayPlanAccess({
    checkedInToday,
    recommendation,
    calendarSessions,
    isRestDay,
    isPlannedRestDay,
    hasRunRecordedToday,
    onCheckIn,
    onStartWorkout,
    onStartUnplannedRun,
    onDetails,
  })
  const { hasViewablePlan } = planAccess
  const calendarKinds = [...new Set(calendarSessions.map(calendarSessionKind))]
  const calendarLabel = calendarKinds.length > 1
    ? 'run + lift'
    : calendarKinds[0] === 'lift'
      ? 'strength'
      : null
  const durationText = formatPlanDuration(recommendation?.durationMinutes, recommendation?.durationIsEstimated)
  const interferenceReason = recommendation?.interference?.adjusted && typeof recommendation?.interference?.reason === 'string'
    ? recommendation.interference.reason.trim()
    : ''
  const coachWhy = interferenceReason || (typeof recommendation?.brief?.why === 'string' ? recommendation.brief.why.trim() : '')
  const buildTodaySubtitle = () => {
    if (allScheduledComplete) return 'All scheduled sessions are complete. Review the work or recover for the next session.'
    if (isRestDay && hasRunRecordedToday) {
      return isPlannedRestDay
        ? 'An extra run is already logged today. Recovery remains the scheduled plan.'
        : 'An extra run is already logged today. Recovery is still the guidance for today.'
    }
    if (!recommendation && isRestDay) return 'Rest and recovery are scheduled today. No check-in is needed unless you choose to train.'
    if (!recommendation && calendarSessions.length > 0) {
      const summaryLabel = calendarLabel || 'training'
      return `${summaryLabel.charAt(0).toUpperCase() + summaryLabel.slice(1)} is scheduled today. Check in only if you want the effort adjusted.`
    }
    if (!recommendation) {
      return checkedInToday
        ? 'No workout is available yet. Review your check-in or open the calendar.'
        : "No workout is scheduled yet. Check in for today's guidance."
    }
    if (isRestDay) {
      if (isPlannedRestDay) {
        return `${readiness.sentencePrefix}Rest and recovery are scheduled today. No check-in is needed unless you choose to train.`
      }
      return planAccess.uncheckedSignal
    }

    const summaryLabel = calendarLabel || recommendationLabel
    const parts = [summaryLabel ? summaryLabel.charAt(0).toUpperCase() + summaryLabel.slice(1) : '']
    const distance = Number(recommendation.suggestedDistance || 0)
    const pace = recommendation.suggestedPace && recommendation.suggestedPace !== '--'
      ? String(recommendation.suggestedPace)
      : ''
    const targetZone = recommendation.targetZone && recommendation.targetZone !== '--'
      ? String(recommendation.targetZone)
      : ''
    const intensity = recommendation.intensity && recommendation.intensity !== '--'
      ? String(recommendation.intensity)
      : ''

    if (distance > 0) {
      parts.push(`${recommendation.suggestedDistance} mi${pace ? ` @ ${pace}` : ''}`)
    } else if (pace) {
      parts.push(`@ ${pace}`)
    }
    if (targetZone) parts.push(targetZone.toLowerCase().startsWith('zone') ? targetZone : `Zone ${targetZone}`)
    if (intensity) parts.push(intensity)
    if (durationText) parts.splice(1, 0, durationText)

    return `${readiness.sentencePrefix}${parts.filter(Boolean).join(' · ')}.`
  }
  return (
    <section className="card-hero p-5">
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="t-micro" style={{ color: 'var(--accent)' }}>Today</p>
          <h2 className="t-title mt-1" style={{ color: 'var(--text-primary)' }}>
            {hasViewablePlan
              ? allScheduledComplete
                ? 'Today\'s plan is complete'
                : checkedInToday
                ? (isRestDay
                    ? (isPlannedRestDay ? 'Recovery is the plan today' : 'Recovery is today\'s guidance')
                    : 'Train from the plan')
                : 'Review today\'s plan'
              : checkedInToday
                ? 'Today\'s plan is not ready'
                : 'Check in for today\'s recommendation'}
          </h2>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            {buildTodaySubtitle()}
          </p>
          {durationText && recommendation?.durationIsEstimated && (
            <p className="mt-1 text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>
              sharpens after a few runs
            </p>
          )}
          {coachWhy && (
            <>
              <p className="mt-2 text-sm italic" style={{ color: 'var(--text-primary)', opacity: 0.9, lineHeight: 1.4 }}>
                {coachWhy}
              </p>
              <AiGuidanceNote />
            </>
          )}
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-32">
          <button
            onClick={planAccess.primaryAction}
            className="pressable rounded-xl px-3 py-2 text-xs font-black"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none' }}
          >
            {planAccess.primaryLabel}
          </button>
          {planAccess.secondaryAction && (
            <button
              onClick={planAccess.secondaryAction}
              className="pressable rounded-xl px-3 py-2 text-xs font-bold"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
            >
              {planAccess.secondaryLabel}
            </button>
          )}
        </div>
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
        @keyframes watchPulse { 0%,100% { box-shadow: 0 0 0 0 var(--border-subtle); } 50% { box-shadow: 0 0 0 8px rgba(234,179,8,0); } }
        @keyframes syncFlash { 0% { background: rgba(34,197,94,0.3); } 100% { background: transparent; } }
      `}</style>
      <button
        onClick={() => {
          setSyncing(true)
          setTimeout(() => setSyncing(false), 1500)
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: hasData ? 'var(--accent-dim)' : 'var(--bg-input)',
          border: `1px solid ${hasData ? 'var(--border-subtle)' : 'var(--border-subtle)'}`,
          borderRadius: 10, padding: '6px 12px', cursor: 'pointer',
          animation: syncing ? 'watchPulse 1s ease-in-out infinite' : 'none',
          transition: 'all 0.3s ease',
          ...(justSynced ? { animation: 'syncFlash 1s ease forwards' } : {}),
        }}
      >
        <Watch size={14} color={hasData ? 'var(--accent)' : 'var(--text-muted)'} />
        <div style={{ textAlign: 'left' }}>
          <p style={{ fontSize: 9, color: 'var(--text-muted)', margin: 0, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            {watchBrand || 'Watch'}
          </p>
          <p style={{ fontSize: 11, fontWeight: 700, color: hasData ? 'var(--accent)' : 'var(--text-muted)', margin: 0 }}>
            {justSynced ? 'Synced!' : hasData ? `HR ${syncStatus.avg_heart_rate || '--'} bpm` : 'No data'}
          </p>
        </div>
        {hasData && (
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', animation: 'watchPulse 2s ease infinite' }} />
        )}
      </button>
    </div>
  )
}

export function TodayDetailSheet({
  open,
  onClose,
  checkedInToday,
  readinessData,
  readinessBreakdown,
  recommendation,
  execution,
  hasRunRecordedToday = false,
  checkinData,
  dailySteps,
  dailyStepsSource,
  activeInjury,
  watchSyncNotice,
  compliance,
  onCheckIn,
  onStartWorkout,
  onStartRun,
  onStartLift,
  onPlanRoute,
  onStartUnplannedRun,
  onWarmup,
  onReflect,
  onOpenReadiness,
}) {
  const { t } = useTranslation()
  if (!open) return null
  const readiness = resolveReadiness(readinessData)
  const calendarSessions = execution?.hasDay && Array.isArray(execution.sessions) ? execution.sessions : []
  const calendarKinds = [...new Set(calendarSessions.map(calendarSessionKind))]
  const isPlannedRestDay = execution?.isPlannedRest === true || execution?.restSource === 'planned'
  const isRestDay = isPlannedRestDay || recommendation?.recommendationType === 'rest' || recommendation?.type === 'rest'
  const planAccess = resolveTodayPlanAccess({
    checkedInToday,
    recommendation,
    calendarSessions,
    isRestDay,
    isPlannedRestDay,
    hasRunRecordedToday,
    onStartUnplannedRun,
  })
  const { hasViewablePlan } = planAccess
  const recommendationLabel = resolveTodayWorkoutLabel({
    calendarKinds,
    recommendationLabel: recommendation ? getRecommendationLabel(recommendation) : null,
  })
  const durationText = formatPlanDuration(recommendation?.durationMinutes, recommendation?.durationIsEstimated)
  const topFactors = (readinessBreakdown || []).filter((item) => item.label !== 'Base score').slice(0, 2)
  const interferenceReason = recommendation?.interference?.adjusted && typeof recommendation?.interference?.reason === 'string'
    ? recommendation.interference.reason.trim()
    : ''
  const coachWhy = interferenceReason || (typeof recommendation?.brief?.why === 'string' ? recommendation.brief.why.trim() : '')
  const effortTargets = [
    { key: 'effort', label: t('today.effortLabel'), value: recommendation?.brief?.effort },
    { key: 'hr', label: t('today.hrLabel'), value: recommendation?.brief?.bpmRange },
    { key: 'cadence', label: t('today.cadenceLabel'), value: recommendation?.brief?.cadence },
  ]
    .map((target) => ({ ...target, value: target.value === null || target.value === undefined ? '' : String(target.value).trim() }))
    .filter((target) => target.value)
  const planSignals = [
    !checkedInToday ? planAccess.uncheckedSignal : null,
    checkedInToday && !hasViewablePlan ? 'No workout recommendation is available yet. Review your check-in or open the calendar.' : null,
    activeInjury ? `Recovery mode is active for ${activeInjury.body_part || 'your injury'}, so workouts are softened until return.` : null,
    watchSyncNotice ? 'A new watch activity was synced and may change load, recovery, and the next workout.' : null,
    compliance && compliance.completed < compliance.planned ? 'Missed planned sessions this week can shift the next run toward base or recovery work.' : null,
    dailySteps !== null ? `${Number(dailySteps).toLocaleString()} steps${dailyStepsSource === 'watch' ? ' from watch sync' : ''} are part of the daily context.` : null,
  ].filter(Boolean)

  return (
    <div
      onClick={onClose}
      className="sheet-backdrop"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="sheet-panel"
        style={{ background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', padding: 24, width: '100%', maxHeight: '82vh', overflowY: 'auto' }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--accent)', letterSpacing: 0.8 }}>Today</p>
            <h2 className="mt-1 text-2xl font-black" style={{ color: 'var(--text-primary)' }}>
              {isRestDay
                ? (isPlannedRestDay ? 'Recovery is the plan today' : 'Recovery is today\'s guidance')
                : (hasViewablePlan ? 'Today\'s training plan' : 'No workout scheduled')}
            </h2>
          </div>
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
            Close
          </button>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Readiness</p>
            <p className="mt-1 text-xl font-black" style={{ color: readiness.available ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {readiness.display}
            </p>
          </div>
          <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Workout</p>
            <p className="mt-1 text-sm font-bold capitalize" style={{ color: 'var(--text-primary)' }}>
              {recommendationLabel || (isRestDay ? 'Rest day' : 'No workout scheduled')}
            </p>
            {recommendation && Number(recommendation.suggestedDistance || 0) > 0 && (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{recommendation.suggestedDistance} mi</p>
            )}
            {durationText && (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{durationText}</p>
            )}
            {durationText && recommendation?.durationIsEstimated && (
              <p className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>sharpens after a few runs</p>
            )}
          </div>
        </div>

        <details className="mt-5 rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
          <summary className="cursor-pointer text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Why this workout</summary>
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
                {planAccess.readinessFallback}
              </p>
            )}
            {(recommendation?.reason || coachWhy) && <AiGuidanceNote />}
          </div>
        </details>

        {calendarSessions.length > 0 ? (
          <section className="mt-5">
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>Today's sessions</p>
            {execution?.orderGuidance && <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>{execution.orderGuidance}</p>}
            <div className="mt-2 space-y-3">
              {calendarSessions.map((session, index) => (
                <TodayCalendarSession
                  key={session?.id || `${calendarSessionKind(session)}-${index}`}
                  session={session}
                  onStartRun={isRestDay ? undefined : onStartRun}
                  onStartLift={isRestDay ? undefined : onStartLift}
                  onPlanRoute={isRestDay ? undefined : onPlanRoute}
                  t={t}
                />
              ))}
            </div>
          </section>
        ) : Array.isArray(recommendation?.structure) && recommendation.structure.length > 0 ? (
          <section className="mt-5">
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>{t('today.workoutBreakdown')}</p>
            <div className="mt-2 space-y-2">
              {recommendation.structure.map((block, i) => (
                <BlockRow key={`detail-${block.phase || 'block'}-${i}`} block={block} t={t} />
              ))}
            </div>
          </section>
        ) : null}

        {coachWhy && (
          <section className="mt-5">
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>{t('today.coachNotes')}</p>
            <p className="mt-2 rounded-xl p-3 text-sm italic" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', lineHeight: 1.5 }}>
              {coachWhy}
            </p>
          </section>
        )}

        {effortTargets.length > 0 && (
          <section className="mt-5">
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>{t('today.effortTargets')}</p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {effortTargets.map((target) => (
                <div key={target.key} className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                  <p className="text-[10px] font-bold uppercase" style={{ color: 'var(--text-muted)' }}>{target.label}</p>
                  <p className="mt-1 text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{target.value}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <details className="mt-5 rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
          <summary className="cursor-pointer text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{isRestDay ? 'Recovery tools' : 'Check-in and recovery tools'}</summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {planAccess.showCheckIn && (
              <button onClick={onCheckIn} className="rounded-xl px-3 py-3 text-sm font-bold" style={{ background: checkedInToday ? 'var(--bg-input)' : 'var(--accent)', color: checkedInToday ? 'var(--text-primary)' : '#000' }}>
                {checkedInToday ? 'Edit check-in' : 'Check in'}
              </button>
            )}
            {planAccess.showStartLog && calendarSessions.length === 0 && (
              <button onClick={onStartWorkout} className="rounded-xl px-3 py-3 text-sm font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
                {isRestDay ? 'View calendar' : 'Start/log'}
              </button>
            )}
            {isPlannedRestDay && planAccess.secondaryAction && (
              <button onClick={planAccess.secondaryAction} className="rounded-xl px-3 py-3 text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
                {planAccess.secondaryLabel}
              </button>
            )}
            {(!isRestDay || isPlannedRestDay) && (
              <button onClick={onWarmup} className="rounded-xl px-3 py-3 text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
                Warm-up
              </button>
            )}
            <button onClick={onReflect} className="rounded-xl px-3 py-3 text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
              Reflect
            </button>
          </div>
          {readiness.available && (
            <button onClick={onOpenReadiness} className="mt-2 w-full rounded-xl px-3 py-3 text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
              Readiness breakdown
            </button>
          )}
        </details>

        <details className="mt-5 rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
          <summary className="cursor-pointer text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Plan context</summary>
          <div className="mt-2 space-y-2">
            {(planSignals.length ? planSignals : ['Forged Hybrid has not detected any missed-session, recovery-mode, or new sync signals today.']).map((signal) => (
              <p key={signal} className="rounded-xl p-3 text-sm" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
                {signal}
              </p>
            ))}
          </div>
        </details>
      </div>
    </div>
  )
}

export function RecentActivityCard({ recentActivity, navigate, fmt, fmtDuration, t }) {
  return (
    <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
      <h3 className="text-base font-bold mb-3" style={{ color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>Recent Activity</h3>
      <div className="space-y-3">
        {recentActivity.map(item => {
          if (item._type === 'run') {
            const isRun = isRunningActivity(item)
            const label = activityLabel(item)
            return (
              <div key={item.id} onClick={() => navigate(`/history?runId=${item.id}`)} className="rounded-xl p-3 border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', borderLeft: `4px solid ${isRun ? 'var(--accent)' : 'var(--success)'}`, cursor: 'pointer' }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: isRun ? 'var(--accent-dim)' : 'rgba(34,197,94,0.12)', color: isRun ? 'var(--accent)' : 'var(--success)' }}>{label}</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {activityDateLabel(item.date || item.created_at)}
                  </span>
                </div>
                <div className="flex gap-4 mt-1">
                  {Number(item.distance_miles || 0) > 0 && <div><p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{fmt.distance(Number(item.distance_miles), 2)}</p></div>}
                  {(isRun || label === 'Walk') && Number(item.distance_miles || 0) > 0 && Number(item.duration_seconds || 0) > 0 && <div><p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{fmt.pace(item.duration_seconds / item.distance_miles)}</p></div>}
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
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>Other Activity</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{new Date(item.synced_at || item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                </div>
                <p className="text-sm font-bold mt-1" style={{ color: 'var(--text-primary)' }}>{item.activity_name || item.activity_type || 'Synced activity'}</p>
              </div>
            )
          }

          if (item._type === 'workout') {
            return (
              <div key={`workout-${item.id}`} onClick={() => navigate(`/history?workoutId=${item.id}`)} className="rounded-xl p-3 border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', borderLeft: '4px solid #a78bfa', cursor: 'pointer' }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(139,92,246,0.15)', color: '#a78bfa' }}>Workout</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {activityDateLabel(item.started_at || item.ended_at || item.created_at)}
                  </span>
                </div>
                <p className="text-sm font-bold mt-1" style={{ color: 'var(--text-primary)' }}>{workoutActivityTitle(item)}</p>
                {Number(item.total_seconds || 0) > 0 && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{fmtDuration(item.total_seconds)}</p>}
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
          <div className="py-4 text-center">
            <Activity size={28} color="var(--accent)" style={{ margin: '0 auto 10px' }} />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{t('dashboard.noActivity')}</p>
          </div>
        )}
      </div>
    </section>
  )
}

export function CalendarDayDetailSheet({ selectedCalendarDay, onClose, fmtDuration }) {
  if (!selectedCalendarDay) return null

  return (
    <div onClick={onClose}
      className="sheet-backdrop"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()}
        className="sheet-panel"
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

function getReadinessBandColor(band) {
  if (band === 'GREEN') return 'var(--accent)'
  if (band === 'AMBER') return 'color-mix(in srgb, var(--accent) 78%, orange)'
  if (band === 'RED') return 'color-mix(in srgb, var(--text-primary) 28%, red)'
  return 'var(--text-muted)'
}

export function ReadinessBreakdownModal({ open, onClose, readinessData }) {
  if (!open) return null

  const readiness = resolveReadiness(readinessData)
  const drivers = !readiness.available
    ? ['Sync Health data to unlock today\'s readiness drivers.']
    : Array.isArray(readinessData?.drivers) && readinessData.drivers.length
    ? readinessData.drivers
    : ['Recovery signals look steady.']
  const bandColor = readiness.available ? getReadinessBandColor(readinessData?.band) : 'var(--text-muted)'

  return (
    <div
      onClick={onClose}
      className="sheet-backdrop"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="sheet-panel"
        style={{ background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', padding: 24, width: '100%', maxHeight: '70vh', overflowY: 'auto' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Readiness</p>
            <p style={{ fontSize: 28, fontWeight: 900, color: bandColor }}>
              {readiness.available ? (
                <>{readiness.score} <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--text-muted)' }}>/ 100</span></>
              ) : 'Readiness unavailable'}
            </p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{readiness.available ? readinessData.verdict : 'Sync Health data to unlock today\'s readiness score.'}</p>
          </div>
          <button onClick={onClose} style={{ background: 'var(--bg-input)', border: 'none', borderRadius: 10, padding: '8px 14px', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>Close</button>
        </div>

        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 }}>Readiness Drivers</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {drivers.map((driver, i) => (
            <div key={i} style={{ background: 'var(--bg-base)', borderRadius: 12, padding: 14 }}>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{driver}</p>
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
      className="sheet-backdrop"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="sheet-panel"
        style={{ background: 'var(--bg-base)', borderRadius: '20px 20px 0 0', padding: 16, width: '100%', maxHeight: '82vh', overflowY: 'auto' }}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--accent)', letterSpacing: 0.8 }}>Forged Hybrid</p>
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
                  <Brain size={16} color="var(--accent)" />
                  <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>Weekly AI Recap</p>
                </div>
                <ChevronRight size={16} color="var(--text-muted)" />
              </div>
              <p className="text-sm font-semibold mt-2" style={{ color: 'var(--text-primary)' }}>
                {Number(weeklyRecap.totalMiles || 0).toFixed(1)} mi · {weeklyRecap.totalRuns || 0} runs · {weeklyRecap.avgPace ? `${weeklyRecap.avgPace}/mi` : 'Pace n/a'}
              </p>
              {weeklyRecap.injuryRiskFlag && (
                <p className="text-xs mt-1" style={{ color: 'var(--warning)' }}>{weeklyRecap.injuryRiskReason || 'Elevated injury risk this week'}</p>
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
              background: loadAnalysis.loadStatus === 'danger' ? 'var(--danger-dim)' : loadAnalysis.loadStatus === 'high' ? 'rgba(249,115,22,0.12)' : 'var(--accent-dim)',
              border: `1px solid ${loadAnalysis.loadStatus === 'danger' ? 'var(--danger-dim)' : loadAnalysis.loadStatus === 'high' ? 'var(--warning-dim)' : 'var(--border-subtle)'}`
            }}>
              <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-primary)' }}>{loadAnalysis.loadStatus} load</p>
              <p className="text-sm mt-1" style={{ color: 'var(--text-primary)' }}>{loadAnalysis.warning || loadAnalysis.recommendation}</p>
              <div className="mt-2 flex gap-2">
                <button className="rounded-lg px-3 py-1.5 text-xs font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }} onClick={() => navigate('/plan', { state: { suggestEasyDay: true } })}>Take Easy Day</button>
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
                    <p key={i} className="text-xs" style={{ color: s.completed ? 'var(--success)' : 'var(--danger)' }}>{s.day}: {s.type} {s.completed ? 'hit' : 'missed'}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {milestones.length > 0 && (
            <div className="space-y-2">
              {milestones.map((m) => (
                <div key={m.key} className="rounded-xl p-3 flex items-center justify-between" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)' }}>
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
              <p className="text-sm font-bold uppercase tracking-wide" style={{ color: 'var(--accent)' }}>Health Sync</p>
              {healthSync.loading ? (
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Syncing...</p>
              ) : (
                <button
                  type="button"
                  onClick={() => navigate('/health')}
                  className="rounded-lg px-3 py-1.5 text-xs font-bold"
                  style={{ background: 'var(--bg-input)', color: 'var(--accent)', border: '1px solid var(--border-subtle)' }}
                >
                  View all
                </button>
              )}
            </div>

            {!proLoading && !isPro && (
              <div>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Sync Apple Health to bring workouts and recovery data into Forge.</p>
                <button
                  type="button"
                  onClick={() => navigate('/health')}
                  className="mt-3 rounded-lg px-3 py-2 text-xs font-bold"
                  style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer' }}
                >
                  Sync Health data
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
                  <p className="mt-3 text-xs" style={{ color: 'var(--warning)' }}>{healthSyncNotice}</p>
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
                          <span className="inline-block h-2 w-2 rounded-full" style={{ background: 'var(--warning)' }} aria-label="Lift logged" />
                        </div>
                      ) : day.hasRun ? (
                        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#0f1117' }} aria-label="Run logged" />
                      ) : day.hasLift ? (
                        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: 'var(--warning)' }} aria-label="Lift logged" />
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
                        ? { background: 'var(--accent)', color: 'var(--on-accent)' }
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
                    return <div key={s.label} className="rounded-lg p-2" style={{ border: '1px solid var(--border-subtle)' }}><p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{s.value}</p><p className="text-xs flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>{s.label}{improving ? <ArrowUpRight size={12} color="var(--success)"/> : <ArrowDownRight size={12} color="var(--danger)"/>}</p></div>
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
                  <Lock size={24} color="var(--accent)" style={{ margin: '0 auto 8px' }} />
                  <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Advanced analytics is Pro-only</p>
                  <button
                    onClick={() => navigate('/upgrade')}
                    className="mt-3 rounded-lg px-3 py-2 text-xs font-bold"
                    style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer' }}
                  >
                    Upgrade to Pro
                  </button>
                </div>
              </div>
            )}
          </div>

          {warning && (
            <div className="rounded-xl border p-3 text-sm" style={{ borderColor: 'var(--border-subtle)', background: 'var(--accent-dim)', color: 'var(--accent)' }}>
              Heavy legs detected — consider a rest day or easy run today
            </div>
          )}

          {shoeAlerts.map(shoe => (
            <div key={shoe.id} style={{ background: 'var(--danger-dim)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 12, padding: '10px 14px' }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--danger)', margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertTriangle size={14} /> Your {shoe.nickname || `${shoe.brand} ${shoe.model}`} has {Number(shoe.total_miles || 0).toFixed(0)} miles — time to replace soon
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0' }}>{shoe.total_miles} of {shoe.recommended_miles || 450} estimated miles</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
