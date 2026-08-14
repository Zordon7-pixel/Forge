import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import {
  Activity, Footprints, Dumbbell, Moon, Timer, Gauge, Route, Flame, Brain,
  Maximize2, Minimize2, Minus, Plus, ChevronLeft, ChevronRight, CheckCircle2, Circle,
  Trash2, HeartPulse, ShieldCheck,
} from 'lucide-react'
import WatchWorkoutSendButton from '../WatchWorkoutSendButton'
import AiGuidanceNote from '../AiGuidanceNote'
import WatchWorkoutService from '../../services/WatchWorkoutService'
import ExerciseGuideAction from '../ExerciseGuideAction'
import { canonicalWorkoutLabel, normalizeLiftExercisePrescription, sessionState } from '../../lib/planCalendar'
import { executionAllowsSession, executionHasSession, isRestExecutionAuthority } from '../../lib/dailyExecutionCore'
import { trainingEvidenceKindLabel } from '../../lib/trainingEvidence'
import './forgedCalendar.css'

const TEXT_SCALES = [0.9, 1, 1.15, 1.3]

// Defensive readers — never invent values that are not present in the plan.
function str(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  return ''
}
function labelText(value) {
  return String(value).replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}
function displayValue(value) {
  const scalar = str(value)
  if (scalar) return scalar
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join(', ')
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => {
        const itemText = displayValue(item)
        return itemText ? `${labelText(key)}: ${itemText}` : ''
      })
      .filter(Boolean)
      .join(' · ')
  }
  return ''
}
function list(value) {
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean)
  const single = displayValue(value)
  return single ? [single] : []
}
function structuredList(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return list(value)
  return Object.entries(value).flatMap(([key, item]) => {
    const valueText = displayValue(item)
    return valueText ? [`${labelText(key)}: ${valueText}`] : []
  })
}
function firstStr(...values) {
  for (const value of values) {
    const s = str(value)
    if (s) return s
  }
  return ''
}
function boolValue(...values) {
  for (const value of values) {
    if (value === true || value === 'true') return true
    if (value === false || value === 'false') return false
  }
  return false
}
function formatDurationLabel(label, isEstimated) {
  const text = str(label)
  if (!text || !isEstimated || /estimate/i.test(text)) return text
  return `${text.startsWith('~') ? '' : '~'}${text} · estimate`
}
function formatAnchorRunDate(value) {
  if (!value) return ''
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/)
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function secondaryWorkoutTitle(session, canonicalTitle) {
  const title = firstStr(session?.motivationalTitle, session?.title)
  return title && title.toLowerCase() !== canonicalTitle.toLowerCase() ? title : ''
}

function formatRecordedDuration(totalSeconds) {
  const total = Math.max(0, Math.round(Number(totalSeconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, '0')}m`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatRecordedPace(secondsPerMile) {
  const total = Math.round(Number(secondsPerMile) || 0)
  if (total <= 0) return ''
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}/mi`
}

function runFacts(session) {
  const p = session.prescription || {}
  const raw = session.raw || {}
  const miles = Number(session.distanceMiles || p.distanceMiles || p.distance_miles || raw.distance_miles || 0)
  const durationMinutes = firstStr(p.duration_min, raw.duration_min)
  const durationIsEstimated = boolValue(session.durationIsEstimated, p.durationIsEstimated, raw.durationIsEstimated, p.duration_is_estimate, raw.duration_is_estimate)
  const durationLabel = firstStr(p.duration, p.time, raw.duration, durationMinutes ? `${durationMinutes} min` : '')
  const distanceIsEstimate = Boolean(session.distanceIsEstimate || p.distance_is_estimate || raw.distance_is_estimate)
  const prescriptionBasis = firstStr(session.prescriptionBasis, p.prescription_basis, raw.prescription_basis)
  const steps = structuredList(p.steps || p.blocks || p.structure || raw.steps || raw.structure)
  return {
    purpose: firstStr(p.purpose, p.focus, raw.purpose),
    distance: miles > 0 && prescriptionBasis !== 'time' ? `${distanceIsEstimate ? '~' : ''}${miles.toFixed(1)} mi${distanceIsEstimate ? ' estimated' : ''}` : '',
    time: formatDurationLabel(durationLabel, durationIsEstimated),
    durationLabel,
    durationMinutes: Number(durationMinutes || session.durationMinutes || 0) || 0,
    durationIsEstimated,
    prescriptionBasis,
    pace: firstStr(p.pace, p.targetPace, p.pace_target, raw.pace, raw.pace_target),
    zone: firstStr(p.zone, p.hrZone, p.heartRateZone, p.target_zone, raw.zone, raw.target_zone),
    intensity: firstStr(p.intensity, raw.intensity),
    warmup: list(p.warmup || raw.warmup),
    steps,
    cooldown: list(p.cooldown || raw.cooldown),
    recoveries: firstStr(p.recoveries, p.recovery),
    evidenceRefs: list(p.evidence_refs || raw.evidence_refs),
  }
}

function liftFacts(session, planContext = {}) {
  const p = session.prescription || {}
  const raw = session.raw || {}
  const exercises = Array.isArray(p.exercises) ? p.exercises
    : Array.isArray(p.main) ? p.main
    : Array.isArray(raw.exercises) ? raw.exercises
    : Array.isArray(raw.main) ? raw.main : []
  const explicitBasis = p.prescriptionBasis || p.prescription_basis || raw.prescriptionBasis || raw.prescription_basis
  const input = planContext.inputSummary || {}
  const basis = explicitBasis && typeof explicitBasis === 'object'
    ? Object.values(explicitBasis).map(displayValue).filter(Boolean)
    : [
        Number(input.recentRunCount || 0) > 0 ? `${Number(input.recentRunCount)} recent runs established the running-load baseline` : '',
        Number(input.recentLiftCount || 0) > 0 ? 'Recent lift history is available; matching logged sets calibrate exact loads' : 'RPE/RIR calibrates load until lift history is available',
        input.appleHealth ? 'Apple Health recovery informed workload and scheduling' : input.checkin ? 'Daily check-in informed workload and scheduling' : '',
        planContext.phase ? `${labelText(planContext.phase)} phase and ${planContext.modeLabel || 'strength goal'}` : '',
        'Evidence-informed sets, reps, and rest intervals',
        'Watch data adjusts workload and recovery; it does not estimate lifting loads',
      ].filter(Boolean)
  const normalizedExercises = exercises.map(normalizeLiftExercisePrescription).map((ex) => ({
    name: firstStr(ex.name, ex.exercise, 'Exercise'),
    sets: firstStr(ex.sets),
    reps: firstStr(ex.reps),
    rest: firstStr(ex.rest),
    load: firstStr(ex.load, ex.weight, ex.targetLoad),
    loadSource: firstStr(ex.loadSource, ex.load_source),
    rpe: firstStr(ex.rpe, ex.RPE, ex.rir, ex.RIR),
    cue: firstStr(ex.cue, ex.formCue, ex.notes),
    progression: firstStr(ex.progression),
    exFocus: firstStr(ex.focus),
  }))
  return {
    focus: firstStr(p.focus, raw.focus),
    warmup: list(p.warmup || raw.warmup),
    recovery: list(p.recovery || raw.recovery),
    progression: firstStr(p.progression, raw.progression),
    basis: [...new Set(basis)],
    totalSets: normalizedExercises.reduce((sum, exercise) => sum + (Number(exercise.sets) || 0), 0),
    exercises: normalizedExercises,
  }
}

function officialMetricFacts(officialStandard = {}) {
  const sharedFacts = [
    officialStandard.loadKgIncludingSled != null ? `${officialStandard.loadKgIncludingSled} kg including sled` : '',
    officialStandard.loadKgPerImplement != null ? `${officialStandard.implements || 2} × ${officialStandard.loadKgPerImplement} kg` : '',
    officialStandard.loadKg != null ? `${officialStandard.loadKg} kg` : '',
    officialStandard.ballKg != null ? `${officialStandard.ballKg} kg ball` : '',
    officialStandard.targetHeightMeters != null ? `${officialStandard.targetHeightMeters} m target` : '',
  ].filter(Boolean)
  const split = officialStandard.loadsByAthleteCategory
  if (!split) return sharedFacts
  const women = officialMetricFacts(split.women || {})
  const men = officialMetricFacts(split.men || {})
  return [
    ...sharedFacts,
    women.length ? `Women: ${women.join(', ')}` : '',
    men.length ? `Men: ${men.join(', ')}` : '',
  ].filter(Boolean)
}

function hyroxFacts(session) {
  const raw = session.raw || session.prescription || {}
  const stationSequence = Array.isArray(raw.stationSequence) ? raw.stationSequence : []
  const officialTeamStationSequence = Array.isArray(raw.officialTeamStationSequence)
    ? raw.officialTeamStationSequence
    : stationSequence
  const isRelay = raw.eventFormat === 'relay' || raw.participationScope === 'relay_athlete'
  return {
    purpose: firstStr(raw.purpose),
    duration: Number(raw.durationMin || session.durationMinutes || 0),
    stationSequence,
    displayedStationSequence: isRelay ? officialTeamStationSequence : stationSequence,
    isRelay,
    athleteStationCount: Number(raw.athleteStationAssignment?.stationCount || stationSequence.length),
    athleteStationInstruction: firstStr(raw.athleteStationAssignment?.instruction),
    runs: Array.isArray(raw.runSequenceMeters) ? raw.runSequenceMeters : [],
    warmUp: list(raw.warmUp || raw.warmup),
    runningTarget: displayValue(raw.runningTarget),
    transitionRest: firstStr(raw.transitionRest),
    stopScaleCriteria: list(raw.stopScaleCriteria),
    canonicalUnits: firstStr(raw.canonicalUnits, 'metric'),
    exactCount: officialTeamStationSequence.filter((station) => station.exactStation).length,
    substitutions: officialTeamStationSequence.filter((station) => !station.exactStation && station.substitute).length,
  }
}

function PaperSection({ title, tone, icon, children, px }) {
  const toneClass = tone === 'green' ? 'forged-sec-green' : tone === 'red' ? 'forged-sec-red' : tone === 'run' ? 'forged-sec-run' : ''
  return (
    <section style={{ marginTop: 18 }}>
      <div className="flex items-center gap-2">
        {icon}
        <h4 className={`forged-hand ${toneClass}`} style={{ fontSize: px(19), fontWeight: 700 }}>{title}</h4>
      </div>
      <div style={{ marginTop: 8 }}>{children}</div>
    </section>
  )
}

function DayBriefContext({ briefDay, px }) {
  if (!briefDay) return null
  const footwear = briefDay.footwear
  return (
    <section className="forged-day-brief" aria-labelledby="forged-day-mission-title">
      <p className="forged-day-brief-kicker">{briefDay.isToday ? "Today's mission" : 'Session mission'}</p>
      <h4 id="forged-day-mission-title" className="forged-hand" style={{ fontSize: px(20) }}>{briefDay.title}</h4>
      {briefDay.mission && <p className="forged-day-brief-purpose" style={{ fontSize: px(13) }}>{briefDay.mission}</p>}
      <div className="forged-day-brief-facts" role="group" aria-label="Session essentials">
        <span data-intensity={briefDay.intensity.key}>{briefDay.intensity.label}</span>
        <span>{briefDay.target}</span>
        {briefDay.effortTarget && <span>{briefDay.effortTarget}</span>}
        {briefDay.hrTarget && (
          <span title={briefDay.hrTarget.sourceLabel}><HeartPulse size={13} aria-hidden="true" /> {briefDay.hrTarget.zoneLabel} · {briefDay.hrTarget.bpmLabel}</span>
        )}
      </div>
      {briefDay.adjustmentReason && (
        <p className="forged-adjusted-because" role="status"><strong>Forge adjusted this because:</strong> {briefDay.adjustmentReason}</p>
      )}
      {footwear && (
        <div className="forged-footwear-card">
          <div className="forged-footwear-head">
            <span><Footprints size={15} aria-hidden="true" /> Footwear</span>
            <Link to="/gear">Update Gear</Link>
          </div>
          {footwear.primary ? (
            <>
              <p><strong>Primary:</strong> {footwear.primary.name}</p>
              <p>{footwear.primary.reason}</p>
              {footwear.alternate && (
                <details>
                  <summary>Alternate: {footwear.alternate.name}</summary>
                  <p>{footwear.alternate.reason}</p>
                </details>
              )}
            </>
          ) : (
            <p>{footwear.state === 'unavailable'
              ? 'Gear is unavailable right now, so no shoe was guessed.'
              : footwear.state === 'wear-review'
                ? footwear.warning
                : 'Add an active pair in Gear to receive a current-inventory recommendation.'}</p>
          )}
          {footwear.primary && footwear.warning && <p className="forged-footwear-warning">{footwear.warning}</p>}
        </div>
      )}
    </section>
  )
}

function SafetyAdjustmentRules({ rules = [], px }) {
  if (!rules.length) return null
  return (
    <details className="forged-safety-rules">
      <summary><ShieldCheck size={16} aria-hidden="true" /> If today changes</summary>
      <ul style={{ fontSize: px(12) }}>
        {rules.map((rule) => (
          <li key={`${rule.if}-${rule.then}`}><strong>If</strong> {rule.if}, <strong>then</strong> {rule.then}.</li>
        ))}
      </ul>
    </details>
  )
}

export default function ForgedDayView({
  day,
  planContext = {},
  completedSet,
  onToggleComplete,
  onRemoveSession,
  onStartRun,
  onStartLift,
  onStartUnplannedRun,
  onOpenRecordedRun,
  onBack,
  updating = false,
  removingSessionId = null,
  removalError = '',
  removalNotice = '',
  allowSessionRemoval = false,
  isScheduledToday = true,
  executionAuthority = null,
  executionAuthorityReady = false,
  routePlanner = null,
  briefDay = null,
  weeklyBrief = null,
}) {
  const [scaleIndex, setScaleIndex] = useState(1)
  const [expanded, setExpanded] = useState(false)
  const containerRef = useRef(null)
  const scale = TEXT_SCALES[scaleIndex]
  const px = (value) => `${Math.round(value * scale)}px`
  const rulePx = `${Math.round(30 * scale)}px`

  const sessions = day?.sessions || []
  const recordedRuns = Array.isArray(day?.activities) ? day.activities.filter((activity) => activity.kind === 'run') : []
  const runSession = sessions.find((s) => s.kind === 'run') || null
  const liftSession = sessions.find((s) => s.kind === 'lift') || null
  const hyroxSessions = sessions.filter((s) => s.kind === 'hyrox')
  const canonicalRestToday = Boolean(
    isScheduledToday
    && executionAuthorityReady
    && isRestExecutionAuthority(executionAuthority),
  )
  const canonicalRestReplacesWorkout = canonicalRestToday && Boolean(day && !day.isRest)
  const canonicalCheckinRest = canonicalRestToday && (
    String(executionAuthority?.checkinOverride?.action || '').trim().toLowerCase() === 'rest'
    || executionAuthority?.sessions?.some((session) => (
      String(session?.checkin_override?.action || session?.checkinOverride?.action || '').trim().toLowerCase() === 'rest'
    ))
  )
  const canExecuteSession = (session, kind) => (
    !isScheduledToday
    || (executionAuthorityReady && executionAllowsSession(executionAuthority, session, kind))
  )
  const recognizesSession = (session, kind) => (
    !isScheduledToday
    || (executionAuthorityReady && executionHasSession(executionAuthority, session, kind))
  )
  const blockedCurrentSessions = isScheduledToday && executionAuthorityReady && !canonicalRestToday && sessions.some((session) => (
    !recognizesSession(session, session.kind)
  ))
  const isRest = !day || day.isRest || canonicalRestToday
  const canonicalRestDescription = firstStr(
    executionAuthority?.checkinOverride?.label,
    executionAuthority?.legacyToday?.description,
    executionAuthority?.sessions?.find((session) => session && session.type === 'rest')?.description,
    "Recovery is today's guidance.",
  )
  const restPrescription = canonicalRestReplacesWorkout
    ? {
        title: canonicalCheckinRest ? "Rest day from today's check-in" : 'No planned workout today',
        raw: {
          description: canonicalCheckinRest
            ? canonicalRestDescription
            : firstStr(executionAuthority?.legacyToday?.description, 'The current daily plan no longer includes this workout.'),
        },
      }
    : day?.restPrescription || null
  const restRaw = restPrescription?.raw || restPrescription?.prescription || {}
  const isRecoveryAlternative = Boolean(restRaw.recovery_alternative)
  const recoveryOptions = Array.isArray(restRaw.recovery_alternative?.options)
    ? restRaw.recovery_alternative.options.filter((option) => option && typeof option === 'object' && !Array.isArray(option))
    : []
  const anchoredBy = planContext.goal?.anchoredBy || day?.anchoredBy || null
  const anchorRunDate = formatAnchorRunDate(anchoredBy?.runDate)

  const dateLabel = useMemo(() => {
    if (!day?.date) return day?.dayLabel || ''
    return day.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
  }, [day])

  useEffect(() => {
    if (!expanded) return undefined
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') { setExpanded(false); return }
      if (event.key !== 'Tab') return
      const focusable = Array.from(containerRef.current?.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)
    containerRef.current?.focus()
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus?.()
    }
  }, [expanded])

  const whyToday = firstStr(day?.whyToday, hyroxSessions[0]?.raw?.purpose, runSession?.prescription?.explanation, liftSession?.prescription?.explanation)
  const dayRecovery = firstStr(day?.recovery)
  const dayRecoveryIsOptional = boolValue(
    day?.raw?.recoveryOptional,
    day?.raw?.recovery_optional,
    day?.raw?.optionalRecovery,
    day?.raw?.optional_recovery,
  )
  const orderGuidance = firstStr(day?.orderGuidance)
  const plannedSessionIds = new Set(sessions.map((session) => String(session.id)))
  const isDone = (session) => sessionState(session, completedSet) === 'completed'
  const runDone = Boolean(runSession && isDone(runSession))
  const liftDone = Boolean(liftSession && isDone(liftSession))
  const liftFirst = Boolean(runSession && liftSession && /lift first/i.test(orderGuidance))
  const primarySessionKind = liftFirst
    ? (!liftDone ? 'lift' : !runDone ? 'run' : null)
    : (!runDone && runSession ? 'run' : !liftDone && liftSession ? 'lift' : null)

  const renderRemoveButton = (session, done) => {
    if (!allowSessionRemoval || done || !session?.removalSessionId || typeof onRemoveSession !== 'function' || !canExecuteSession(session, session?.kind)) return null
    const removing = String(removingSessionId || '') === String(session.removalSessionId)
    return (
      <button
        type="button"
        onClick={() => onRemoveSession(session)}
        disabled={removing || updating}
        aria-label={`Remove ${session.title || 'workout'} from this plan`}
        style={{ flex: '0 0 auto', minHeight: 44, border: '1px solid rgba(185,28,28,0.28)', borderRadius: 8, padding: '10px 12px', background: 'rgba(185,28,28,0.07)', color: '#B91C1C', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: px(12), fontWeight: 850, cursor: removing ? 'wait' : 'pointer' }}
      >
        <Trash2 size={15} /> {removing ? 'Removing…' : 'Remove workout'}
      </button>
    )
  }

  const renderRecordedRuns = () => {
    if (!recordedRuns.length) return null
    return (
      <section style={{ marginTop: 16, padding: '12px 0', borderTop: '1px solid rgba(60,55,45,0.16)', borderBottom: '1px solid rgba(60,55,45,0.16)' }}>
        <div className="flex items-center gap-2">
          <span className="forged-stamp forged-stamp--run" data-state="completed"><Footprints size={15} /></span>
          <div>
            <h4 className="forged-hand" style={{ fontSize: px(17), fontWeight: 700, margin: 0 }}>Recorded on this date</h4>
            <p style={{ fontSize: px(11), color: 'var(--ink-soft, #5A554B)', margin: '2px 0 0' }}>Saved activity stays separate from the planned prescription.</p>
          </div>
        </div>
        <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          {recordedRuns.map((activity) => {
            const linked = Boolean(activity.planSessionId && plannedSessionIds.has(String(activity.planSessionId)))
            const facts = [
              activity.distanceMiles > 0 ? `${activity.distanceMiles.toFixed(2)} mi` : null,
              activity.durationSeconds > 0 ? formatRecordedDuration(activity.durationSeconds) : null,
              formatRecordedPace(activity.paceSecondsPerMile),
            ].filter(Boolean).join(' · ')
            return (
              <button
                key={activity.id}
                type="button"
                onClick={() => onOpenRecordedRun?.(activity)}
                disabled={typeof onOpenRecordedRun !== 'function'}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 11px', textAlign: 'left', borderRadius: 8, border: '1px solid rgba(60,55,45,0.14)', background: 'rgba(255,255,255,0.28)', color: 'var(--ink, #241F18)' }}
              >
                <span style={{ minWidth: 0 }}>
                  <strong style={{ display: 'block', fontSize: px(13) }}>Run complete</strong>
                  {facts && <span style={{ display: 'block', fontSize: px(12), marginTop: 2 }}>{facts}</span>}
                  <span style={{ display: 'block', fontSize: px(10), marginTop: 3, color: linked ? '#15803D' : '#9A3412', fontWeight: 800 }}>
                    {linked ? 'Linked to this planned run' : 'Recorded separately from this plan'}
                  </span>
                </span>
                {typeof onOpenRecordedRun === 'function' && <ChevronRight size={17} style={{ flex: '0 0 auto' }} />}
              </button>
            )
          })}
        </div>
      </section>
    )
  }

  const renderHyrox = (hyroxSession) => {
    const facts = hyroxFacts(hyroxSession)
    const done = isDone(hyroxSession)
    const recognized = recognizesSession(hyroxSession, 'hyrox')
    const canExecute = canExecuteSession(hyroxSession, 'hyrox')
    return (
      <PaperSection key={hyroxSession.id} title={hyroxSession.title || 'HYROX session'} tone="red" px={px}
        icon={<span className="forged-stamp forged-stamp--hyrox" data-state={sessionState(hyroxSession, completedSet)}><Activity size={16} /></span>}>
        <p className="forged-must-do">Must do</p>
        <p className="forged-hand" style={{ margin: '0 0 8px', fontSize: px(15), fontWeight: 800 }}>HYROX-specific session · canonical metric prescription</p>
        {facts.purpose && <p style={{ margin: '0 0 9px', fontSize: px(13), lineHeight: 1.5 }}>{facts.purpose}</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '9px 10px', borderRadius: 8, background: 'rgba(194,65,12,0.05)', fontSize: px(12) }}>
          {facts.duration > 0 && <span><Timer size={13} style={{ verticalAlign: -2 }} /> {facts.duration} min</span>}
          {facts.runs.length > 0 && <span><Route size={13} style={{ verticalAlign: -2 }} /> {facts.runs.length} × 1,000 m run</span>}
          <span>{facts.isRelay ? `${facts.athleteStationCount} team-assigned stations` : `${facts.stationSequence.length} ordered stations`}</span>
          <span>{facts.canonicalUnits} canonical</span>
        </div>
        {facts.isRelay && <p role="note" style={{ margin: '8px 0 0', fontSize: px(12), fontWeight: 800 }}>Athlete scope: 2 × 1,000 m run + 2 team-assigned stations. {facts.athleteStationInstruction}</p>}
        {facts.runningTarget && <p style={{ margin: '8px 0 0', fontSize: px(12) }}><strong>Running target:</strong> {facts.runningTarget}</p>}
        {facts.warmUp.length > 0 && <div style={{ marginTop: 10 }}><strong style={{ fontSize: px(13) }}>Warm-up</strong><ol style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: px(12) }}>{facts.warmUp.map((item, index) => <li key={`hyrox-warm-${index}`}>{item}</li>)}</ol></div>}
        {facts.isRelay && <p style={{ margin: '12px 0 0', fontSize: px(13), fontWeight: 900 }}>Official team station order — assign two stations to this athlete</p>}
        <ol style={{ display: 'grid', gap: 8, margin: '12px 0 0', padding: 0, listStyle: 'none', minWidth: 0 }}>
          {facts.displayedStationSequence.map((station, index) => {
            const dose = [station.distanceMeters != null ? `${station.distanceMeters} m` : '', station.repetitions != null ? `${station.repetitions} reps` : ''].filter(Boolean).join(' · ')
            const official = officialMetricFacts(station.officialStandard)
            return (
              <li key={`${station.id || station.name}-${index}`} style={{ minWidth: 0, padding: 10, borderRadius: 8, border: '1px solid rgba(60,55,45,0.15)', background: 'rgba(255,255,255,0.25)', overflowWrap: 'anywhere' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                  <strong style={{ fontSize: px(13) }}>{index + 1}. {station.name || labelText(station.id)}</strong>
                  <span style={{ flex: '0 0 auto', fontSize: px(10), fontWeight: 900 }}>{station.exactStation ? 'EXACT STATION' : 'PATTERN ONLY'}</span>
                </div>
                {dose && <p style={{ margin: '4px 0 0', fontSize: px(12) }}>{dose}</p>}
                {station.loadGuidance && <p style={{ margin: '3px 0 0', fontSize: px(11) }}><strong>Training load:</strong> {station.loadGuidance}</p>}
                {official.length > 0 && <p style={{ margin: '3px 0 0', fontSize: px(11) }}><strong>Official metric reference:</strong> {official.join(' · ')}</p>}
                {!station.exactStation && station.substitute && <p style={{ margin: '5px 0 0', fontSize: px(11), color: '#9A3412', fontWeight: 800 }}>Substitute: {station.substitute}. This does not claim exact station readiness.</p>}
              </li>
            )
          })}
        </ol>
        {facts.substitutions > 0 && <p role="status" style={{ margin: '10px 0 0', padding: 9, borderRadius: 8, background: 'rgba(194,65,12,0.08)', fontSize: px(11), fontWeight: 800 }}>{facts.substitutions} station pattern{facts.substitutions === 1 ? '' : 's'} use truthful substitutions; exact readiness is not claimed.</p>}
        {facts.transitionRest && <p style={{ margin: '9px 0 0', fontSize: px(12) }}><strong>Transition / rest:</strong> {facts.transitionRest}</p>}
        {facts.stopScaleCriteria.length > 0 && (
          <div style={{ marginTop: 10 }}><strong style={{ fontSize: px(13) }}>Stop or scale when</strong><ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: px(12) }}>{facts.stopScaleCriteria.map((item, index) => <li key={`hyrox-stop-${index}`}>{item}</li>)}</ul></div>
        )}
        {recognized && <>
          <button type="button" onClick={() => onToggleComplete?.(hyroxSession.id)} disabled={updating} style={{ width: '100%', minHeight: 48, marginTop: 12, border: '1px solid rgba(60,55,45,0.2)', borderRadius: 8, padding: '12px 14px', background: 'transparent', fontSize: px(13), fontWeight: 850 }}>
            {done ? <CheckCircle2 size={16} color="#15803D" style={{ display: 'inline', marginRight: 6, verticalAlign: -3 }} /> : <Circle size={16} style={{ display: 'inline', marginRight: 6, verticalAlign: -3 }} />}{done ? 'HYROX session done' : 'Mark HYROX session done'}
          </button>
          {canExecute && <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>{renderRemoveButton(hyroxSession, done)}</div>}
        </>}
      </PaperSection>
    )
  }

  const renderRun = () => {
    if (!runSession) return null
    const f = runFacts(runSession)
    const done = isDone(runSession)
    const watchWorkout = WatchWorkoutService.buildRunWorkout({
      day: dateLabel,
      typeLabel: runSession.title,
      distanceLabel: f.distance,
      durationMinutes: f.durationMinutes,
      durationLabel: f.durationLabel,
      prescriptionBasis: f.prescriptionBasis,
      pace: f.pace || undefined,
      zone: f.zone || undefined,
      intensity: f.intensity || undefined,
      steps: f.steps,
      progression: firstStr(runSession.prescription?.progression, runSession.raw?.progression),
      description: firstStr(runSession.prescription?.description, runSession.raw?.description),
    })
    const zoneLabel = /^\d+$/.test(f.zone) ? `Zone ${f.zone}` : f.zone
    const evidenceById = new Map((planContext.trainingEvidence || []).map((source) => [source.id, source]))
    const evidenceSources = f.evidenceRefs.map((id) => evidenceById.get(id)).filter(Boolean)
    const isBenchmarkRun = Boolean(runSession.isBenchmark || runSession.raw?.benchmark || runSession.prescription?.benchmark || runSession.type === 'benchmark')
    const canonicalTitle = canonicalWorkoutLabel(runSession)
    const secondaryTitle = secondaryWorkoutTitle(runSession, canonicalTitle)
    const isPrimary = primarySessionKind === 'run'
    const recognized = recognizesSession(runSession, 'run')
    const canExecute = canExecuteSession(runSession, 'run')
    return (
      <PaperSection title={canonicalTitle} tone="run" px={px}
        icon={<span className="forged-stamp forged-stamp--run" data-state={sessionState(runSession, completedSet)}><Footprints size={16} /></span>}>
        <p className="forged-must-do">Must do</p>
        {secondaryTitle && <p className="forged-hand" style={{ fontSize: px(15), margin: '0 0 8px', fontWeight: 800 }}>{secondaryTitle}</p>}
        {isBenchmarkRun && (
          <p className="forged-hand forged-sec-red" style={{ fontSize: px(14), margin: '0 0 8px', fontWeight: 800 }}>
            Benchmark run — this calibrates your targets
          </p>
        )}
        {f.purpose && f.purpose !== briefDay?.mission && <p className="forged-hand" style={{ fontSize: px(15), margin: '0 0 8px' }}>{f.purpose}</p>}
        <div className="forged-paper-metric" style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
          {f.time && <span style={{ fontSize: px(13) }}><Timer size={13} style={{ verticalAlign: -1 }} /> {f.time}</span>}
          {f.distance && <span style={{ fontSize: px(13) }}><Route size={13} style={{ verticalAlign: -1 }} /> {f.distance}</span>}
          {f.pace && <span style={{ fontSize: px(13) }}><Gauge size={13} style={{ verticalAlign: -1 }} /> {f.pace}</span>}
          {f.zone && <span style={{ fontSize: px(13) }}>{zoneLabel}</span>}
          {f.intensity && <span className="forged-sec-red" style={{ fontSize: px(13) }}><Flame size={13} style={{ verticalAlign: -1 }} /> {f.intensity}</span>}
        </div>
        {f.time && f.durationIsEstimated && <p style={{ fontSize: px(11), margin: '6px 0 0', color: 'var(--ink-soft, #5A554B)' }}>sharpens after a few runs</p>}
        {f.prescriptionBasis === 'time' && <p style={{ fontSize: px(11), margin: '6px 0 0', color: 'var(--ink-soft, #5A554B)' }}>Run by time and effort; distance is not the target.</p>}
        {evidenceSources.length > 0 && (
          <details style={{ marginTop: 10, padding: '8px 10px', borderLeft: '3px solid #C2410C', background: 'rgba(194,65,12,0.05)' }}>
            <summary className="forged-hand" style={{ fontSize: px(13), fontWeight: 700, cursor: 'pointer' }}>Training basis</summary>
            <ul style={{ margin: '5px 0 0', paddingLeft: 17, fontSize: px(11), lineHeight: 1.45 }}>
              {evidenceSources.map((source) => (
                <li key={source.id}>
                  <strong>{trainingEvidenceKindLabel(source.kind)}: </strong>
                  <a href={source.url} target="_blank" rel="noreferrer" style={{ color: '#9A3412', fontWeight: 700 }}>{source.publisher}</a>: {source.principle}
                </li>
              ))}
            </ul>
          </details>
        )}
        {f.warmup.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <p className="forged-hand forged-sec-green" style={{ fontSize: px(14), margin: 0 }}>Warm-up</p>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: px(13) }}>{f.warmup.map((it, i) => <li key={`wu-${i}`}>{it}</li>)}</ul>
          </div>
        )}
        {f.steps.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <p style={{ fontSize: px(13), fontWeight: 700, margin: 0 }}>Structure</p>
            <ol style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: px(13) }}>{f.steps.map((it, i) => <li key={`st-${i}`}>{it}</li>)}</ol>
          </div>
        )}
        {f.recoveries && <p style={{ fontSize: px(12), marginTop: 8 }}>Recoveries: {f.recoveries}</p>}
        {f.cooldown.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <p className="forged-hand forged-sec-green" style={{ fontSize: px(14), margin: 0 }}>Cool-down</p>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: px(13) }}>{f.cooldown.map((it, i) => <li key={`cd-${i}`}>{it}</li>)}</ul>
          </div>
        )}
        {recognized && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {canExecute && (
              <button type="button" onClick={() => onStartRun?.(runSession)} disabled={typeof onStartRun !== 'function'}
                title="Start this scheduled run"
                className={isPrimary ? 'forged-start-run' : undefined} style={{ flex: '1 1 140px', minHeight: 48, border: isPrimary ? 'none' : '1px solid rgba(60,55,45,0.24)', borderRadius: 8, padding: '12px', background: isPrimary ? undefined : 'transparent', color: isPrimary ? undefined : 'var(--ink, #241F18)', fontWeight: 900, fontSize: px(14), cursor: typeof onStartRun === 'function' ? 'pointer' : 'not-allowed', opacity: typeof onStartRun === 'function' ? 1 : 0.5 }}>
                Start Run
              </button>
            )}
            <button type="button" onClick={() => onToggleComplete?.(runSession.id)} disabled={updating}
              style={{ flex: '0 0 auto', border: '1px solid rgba(60,55,45,0.2)', borderRadius: 8, padding: '12px 14px', background: 'transparent', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: px(13), cursor: 'pointer' }}>
              {done ? <CheckCircle2 size={16} color="#15803D" /> : <Circle size={16} />} {done ? 'Done' : 'Mark done'}
            </button>
            {canExecute && renderRemoveButton(runSession, done)}
          </div>
        )}
        {canExecute && <>{routePlanner}<WatchWorkoutSendButton workout={watchWorkout} className="mt-2" /></>}
      </PaperSection>
    )
  }

  const renderLift = () => {
    if (!liftSession) return null
    const f = liftFacts(liftSession, planContext)
    const done = isDone(liftSession)
    const watchWorkout = WatchWorkoutService.buildStrengthWorkout({
      workoutName: liftSession.title,
      target: f.focus,
      warmup: f.warmup,
      main: f.exercises,
      recovery: f.recovery,
      explanation: firstStr(liftSession.prescription?.explanation, liftSession.raw?.explanation),
    })
    const canonicalTitle = canonicalWorkoutLabel(liftSession)
    const secondaryTitle = secondaryWorkoutTitle(liftSession, canonicalTitle)
    const isPrimary = primarySessionKind === 'lift'
    const recognized = recognizesSession(liftSession, 'lift')
    const canExecute = canExecuteSession(liftSession, 'lift')
    return (
      <PaperSection title={canonicalTitle} px={px}
        icon={<span className="forged-stamp forged-stamp--lift" data-state={sessionState(liftSession, completedSet)}><Dumbbell size={16} /></span>}>
        <p className="forged-must-do">Must do</p>
        {secondaryTitle && <p className="forged-hand" style={{ fontSize: px(15), margin: '0 0 8px', fontWeight: 800 }}>{secondaryTitle}</p>}
        {f.focus && <p className="forged-hand" style={{ fontSize: px(15), margin: '0 0 8px' }}>{f.focus}</p>}
        <div style={{ marginBottom: 10, padding: '9px 10px', border: '1px solid rgba(60,55,45,0.14)', borderRadius: 8, background: 'rgba(255,255,255,0.28)' }}>
          <p style={{ margin: 0, fontSize: px(13), fontWeight: 800 }}>{f.exercises.length} exercises · {f.totalSets || '—'} working sets</p>
          <p style={{ margin: '2px 0 0', fontSize: px(11), color: 'var(--ink-soft, #5A554B)' }}>Sets, reps, load, effort, and rest are listed for every exercise.</p>
        </div>
        {f.basis.length > 0 && (
          <details style={{ marginBottom: 10, padding: '9px 10px', borderLeft: '3px solid #C2410C', background: 'rgba(194,65,12,0.05)' }}>
            <summary className="forged-hand" style={{ fontSize: px(13), fontWeight: 700, cursor: 'pointer' }}>Why these numbers</summary>
            <ul style={{ margin: '4px 0 0', paddingLeft: 17, fontSize: px(11), lineHeight: 1.45 }}>{f.basis.map((item, index) => <li key={`basis-${index}`}>{item}</li>)}</ul>
          </details>
        )}
        {f.warmup.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <p className="forged-hand forged-sec-green" style={{ fontSize: px(14), margin: 0 }}>Warm-up</p>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: px(13) }}>{f.warmup.map((it, i) => <li key={`lwu-${i}`}>{it}</li>)}</ul>
          </div>
        )}
        {f.exercises.map((ex, index) => (
          <div className="forged-exercise" key={`ex-${ex.name}-${index}`}>
            <div className="flex items-start justify-between gap-2">
              <p style={{ fontSize: px(15), fontWeight: 800, margin: 0 }}>{index + 1}. {ex.name}</p>
              {ex.exFocus && <span className="forged-sec-green" style={{ fontSize: px(11), fontWeight: 800, textTransform: 'uppercase' }}>{ex.exFocus}</span>}
            </div>
            <div className="forged-exercise-metrics">
              <span>Sets<strong style={{ fontSize: px(15) }}>{ex.sets || '—'}</strong></span>
              <span>Reps<strong style={{ fontSize: px(15) }}>{ex.reps || '—'}</strong></span>
              <span>Rest<strong style={{ fontSize: px(15) }}>{ex.rest || '—'}</strong></span>
              <span>Load<strong style={{ fontSize: px(15) }}>{ex.load || '—'}</strong></span>
              <span>RPE/RIR<strong style={{ fontSize: px(15) }}>{ex.rpe || '—'}</strong></span>
            </div>
            {ex.loadSource && <p style={{ fontSize: px(11), marginTop: 6, color: 'var(--ink-soft, #5A554B)' }}><strong>Load basis:</strong> {ex.loadSource}</p>}
            {ex.cue && <p style={{ fontSize: px(12), marginTop: 6, color: 'var(--ink-soft, #5A554B)' }}>{ex.cue}</p>}
            {ex.progression && <p style={{ fontSize: px(11), marginTop: 4, color: 'var(--ink-soft, #5A554B)' }}><strong>Progress:</strong> {ex.progression}</p>}
            <div style={{ marginTop: 8 }}>
              <ExerciseGuideAction exercise={ex} />
            </div>
          </div>
        ))}
        {f.progression && <p style={{ fontSize: px(12), marginTop: 8 }}><strong>Session progression:</strong> {f.progression}</p>}
        {f.recovery.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <p className="forged-hand forged-sec-green" style={{ fontSize: px(14), margin: 0 }}>Recovery</p>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: px(13) }}>{f.recovery.map((item, index) => <li key={`lift-recovery-${index}`}>{item}</li>)}</ul>
          </div>
        )}
        {recognized && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {canExecute && (
              <button type="button" onClick={() => onStartLift?.(liftSession)} disabled={typeof onStartLift !== 'function'}
                title="Start this scheduled lift"
                className={isPrimary ? 'forged-start-lift' : undefined} style={{ flex: '1 1 140px', minHeight: 48, border: isPrimary ? 'none' : '1px solid rgba(60,55,45,0.24)', borderRadius: 8, padding: '12px', background: isPrimary ? undefined : 'transparent', color: isPrimary ? undefined : 'var(--ink, #241F18)', fontWeight: 900, fontSize: px(14), cursor: typeof onStartLift === 'function' ? 'pointer' : 'not-allowed', opacity: typeof onStartLift === 'function' ? 1 : 0.5 }}>
                Start Lift
              </button>
            )}
            <button type="button" onClick={() => onToggleComplete?.(liftSession.id)} disabled={updating}
              style={{ flex: '0 0 auto', border: '1px solid rgba(60,55,45,0.2)', borderRadius: 8, padding: '12px 14px', background: 'transparent', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: px(13), cursor: 'pointer' }}>
              {done ? <CheckCircle2 size={16} color="#15803D" /> : <Circle size={16} />} {done ? 'Done' : 'Mark done'}
            </button>
            {canExecute && renderRemoveButton(liftSession, done)}
          </div>
        )}
        {canExecute && <WatchWorkoutSendButton workout={watchWorkout} className="mt-2" />}
      </PaperSection>
    )
  }

  return (
    <div
      ref={containerRef}
      className={`forged-cal forged-paper ${expanded ? 'forged-paper--full' : ''}`}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded ? 'true' : undefined}
      aria-label={expanded ? `${dateLabel} workout expanded` : undefined}
      tabIndex={expanded ? -1 : undefined}
      style={{
        '--rule': rulePx,
        position: expanded ? 'fixed' : 'relative',
        inset: expanded ? 0 : 'auto',
        zIndex: expanded ? 70 : 'auto',
        height: expanded ? '100dvh' : 'auto',
        overflowY: expanded ? 'auto' : 'visible',
        overflowX: 'hidden',
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        padding: 16,
        paddingTop: expanded ? 'calc(env(safe-area-inset-top, 0px) + 16px)' : 16,
        paddingBottom: expanded ? 'calc(env(safe-area-inset-bottom, 0px) + 24px)' : 16,
      }}
    >
      <header className="flex items-start justify-between gap-3" style={{ flexWrap: 'wrap', minWidth: 0 }}>
        <div style={{ minWidth: 0 }}>
          <button type="button" onClick={onBack}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'var(--ink-soft, #5A554B)', fontSize: px(12), fontWeight: 700, padding: 0, cursor: 'pointer' }}>
            <ChevronLeft size={15} /> Calendar
          </button>
          <h3 className="forged-hand" style={{ fontSize: px(24), fontWeight: 700, margin: '6px 0 0' }}>{dateLabel}</h3>
          {planContext.phase && <p style={{ fontSize: px(12), margin: '2px 0 0', color: 'var(--ink-soft, #5A554B)' }}>{planContext.phase} · {planContext.modeLabel}</p>}
          {anchorRunDate && <p style={{ fontSize: px(12), margin: '2px 0 0', color: 'var(--ink-soft, #5A554B)' }}>Target set from your {anchorRunDate} run</p>}
        </div>
        <div className="forged-paper-controls" style={{ maxWidth: '100%', marginLeft: 'auto' }}>
          <button type="button" onClick={() => setScaleIndex((v) => Math.max(0, v - 1))} disabled={scaleIndex === 0} aria-label="Make text smaller" title="Smaller text" style={{ opacity: scaleIndex === 0 ? 0.4 : 1 }}><Minus size={16} /></button>
          <span aria-live="polite" style={{ width: 40, textAlign: 'center', fontSize: 11, fontWeight: 800 }}>{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => setScaleIndex((v) => Math.min(TEXT_SCALES.length - 1, v + 1))} disabled={scaleIndex === TEXT_SCALES.length - 1} aria-label="Make text larger" title="Larger text" style={{ opacity: scaleIndex === TEXT_SCALES.length - 1 ? 0.4 : 1 }}><Plus size={16} /></button>
          <button type="button" onClick={() => setExpanded((v) => !v)} aria-label={expanded ? 'Close full screen' : 'Full screen'} title={expanded ? 'Close full screen' : 'Full screen'}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
        </div>
      </header>

      {removalError && <p role="alert" style={{ fontSize: px(12), margin: '12px 0 0', padding: '9px 10px', borderRadius: 8, background: 'rgba(185,28,28,0.08)', color: '#B91C1C' }}>{removalError}</p>}
      {removalNotice && <p role="status" aria-live="polite" style={{ fontSize: px(12), margin: '12px 0 0', padding: '9px 10px', borderRadius: 8, background: 'rgba(22,163,74,0.1)', color: '#166534' }}>{removalNotice}</p>}
      {isScheduledToday && !executionAuthorityReady && (
        <p role="alert" style={{ fontSize: px(12), margin: '12px 0 0', padding: '9px 10px', borderRadius: 8, background: 'rgba(185,28,28,0.08)', color: '#B91C1C' }}>
          Today&apos;s safety status could not be verified. Refresh before starting, exporting, or changing this workout.
        </p>
      )}
      {blockedCurrentSessions && executionAuthorityReady && (
        <p role="status" aria-live="polite" style={{ fontSize: px(12), margin: '12px 0 0', padding: '9px 10px', borderRadius: 8, background: 'rgba(194,65,12,0.08)', color: '#9A3412' }}>
          Today&apos;s plan changed. Refresh this day before starting, exporting, or changing the retained workout.
        </p>
      )}

      {!isScheduledToday && !isRest && (
        <p role="status" style={{ fontSize: px(12), margin: '12px 0 0', padding: '8px 10px', borderRadius: 8, background: 'rgba(60,55,45,0.06)', color: 'var(--ink-soft, #5A554B)' }}>
          This workout is scheduled for {dateLabel}. You can start it now; Forged Hybrid will confirm before continuing.
        </p>
      )}

      <DayBriefContext briefDay={briefDay} px={px} />

      {renderRecordedRuns()}

      {isRest ? (
        <section style={{ marginTop: 24, textAlign: 'center' }}>
          <span className="forged-stamp forged-stamp--rest" style={{ margin: '0 auto' }}><Moon size={16} /></span>
          <h4 className="forged-hand" style={{ fontSize: px(20), fontWeight: 700, marginTop: 10 }}>{day?.hasPlan === false ? 'No planned workout' : restPrescription?.title || 'Planned rest day'}</h4>
          <p style={{ fontSize: px(13), color: 'var(--ink-soft, #5A554B)', marginTop: 4 }}>{day?.hasPlan === false ? 'This recorded run was outside the active plan.' : firstStr(restRaw.description, 'Recover well and come back ready.')}</p>
          {recoveryOptions.length > 0 && (
            <div style={{ display: 'grid', gap: 8, maxWidth: 520, margin: '14px auto 0', textAlign: 'left' }}>
              {recoveryOptions.map((option) => {
                const range = list(option.duration_range_minutes)
                const duration = range.length === 2
                  ? `${range[0]}–${range[1]} min`
                  : Number(option.duration_minutes) === 0
                    ? 'Full rest'
                    : Number(option.duration_minutes) > 0 ? `${option.duration_minutes} min` : 'Duration not prescribed'
                return (
                  <div key={option.type} style={{ padding: 10, borderRadius: 8, background: 'rgba(60,55,45,0.06)', border: '1px solid rgba(60,55,45,0.12)' }}>
                    <strong style={{ display: 'block', fontSize: px(13), textTransform: 'capitalize' }}>{option.type}</strong>
                    <p style={{ margin: '3px 0 0', fontSize: px(12), fontWeight: 800 }}><Timer size={13} style={{ display: 'inline', marginRight: 4, verticalAlign: -2 }} />{duration} · {firstStr(option.intensity, 'Very easy')}</p>
                    {firstStr(option.guidance) && <p style={{ margin: '4px 0 0', fontSize: px(12) }}>{firstStr(option.guidance)}</p>}
                    {firstStr(option.safety_rationale) && <p style={{ margin: '4px 0 0', fontSize: px(11), color: 'var(--ink-soft, #5A554B)' }}>Safety: {firstStr(option.safety_rationale)}</p>}
                  </div>
                )
              })}
            </div>
          )}
          {recoveryOptions.length === 0 && list(restRaw.steps).length > 0 && (
            <ol style={{ margin: '12px auto 0', maxWidth: 520, paddingLeft: 22, textAlign: 'left', fontSize: px(12), lineHeight: 1.55 }}>
              {list(restRaw.steps).map((step, index) => <li key={`rest-step-${index}`}>{step}</li>)}
            </ol>
          )}
          {firstStr(restRaw.progression) && <p style={{ fontSize: px(12), color: 'var(--ink-soft, #5A554B)', marginTop: 10 }}>{firstStr(restRaw.progression)}</p>}
          {isScheduledToday && !canonicalRestReplacesWorkout && (
            !isRecoveryAlternative ? <>
              <button
                type="button"
                onClick={onStartUnplannedRun}
                disabled={typeof onStartUnplannedRun !== 'function'}
                className="forged-start-run"
                style={{ marginTop: 16, width: '100%', minHeight: 48, border: 'none', borderRadius: 8, padding: '12px 14px', fontWeight: 900, cursor: typeof onStartUnplannedRun === 'function' ? 'pointer' : 'not-allowed', opacity: typeof onStartUnplannedRun === 'function' ? 1 : 0.5 }}
              >
                Start a run
              </button>
              <p style={{ fontSize: px(11), color: 'var(--ink-soft, #5A554B)', marginTop: 6 }}>Choose an extra run or move a missed session onto today.</p>
            </> : null
          )}
        </section>
      ) : (
        <>
          {hyroxSessions.map(renderHyrox)}
          {orderGuidance && (runSession && liftSession) && (
            <p className="forged-hand" style={{ fontSize: px(14), marginTop: 12, padding: '8px 10px', background: 'rgba(60,55,45,0.05)', borderRadius: 8 }}>{orderGuidance}</p>
          )}
          {renderRun()}
          {renderLift()}
          {dayRecovery && (
            <PaperSection title={dayRecoveryIsOptional ? 'Optional recovery' : 'Recovery'} tone="green" px={px}
              icon={<span className="forged-stamp forged-stamp--sm forged-stamp--rest"><Moon size={12} /></span>}>
              <p style={{ fontSize: px(13) }}>{dayRecovery}</p>
            </PaperSection>
          )}
        </>
      )}

      {whyToday && (
        <details className="forged-why-workout">
          <summary><Brain size={17} color="#C2410C" /> Why this workout?</summary>
          <p style={{ fontSize: px(13), lineHeight: 1.55 }}>{whyToday}</p>
          <AiGuidanceNote />
        </details>
      )}
      <SafetyAdjustmentRules rules={weeklyBrief?.safetyRules} px={px} />
    </div>
  )
}
