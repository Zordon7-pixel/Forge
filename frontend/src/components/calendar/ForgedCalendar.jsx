import { useMemo, useRef, useState } from 'react'
import {
  Footprints, Dumbbell, Moon, ChevronDown, ChevronLeft, ChevronRight, Pencil,
} from 'lucide-react'
import {
  buildMonthGrid, addMonths, dayMarks, dayStatus, countdownDays, WEEKDAYS,
} from '../../lib/planCalendar'
import './forgedCalendar.css'

const MONTH_DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const PHASE_PURPOSE = Object.freeze({
  base: 'Establish consistent aerobic volume and durable movement before race-specific load increases.',
  build: 'Increase sustainable speed and long-run durability with controlled weekly progression.',
  deload: 'Reduce training stress so the previous work can be absorbed without losing rhythm.',
  peak: 'Practice the race demands at the highest sustainable load before the taper.',
  taper: 'Lower fatigue while preserving goal-pace familiarity and movement quality.',
  race: 'Arrive rested, confident, and ready to execute the prepared race strategy.',
})

function formatGoalTime(seconds) {
  const total = Math.round(Number(seconds))
  if (!Number.isFinite(total) || total <= 0) return null
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remaining = total % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
}

function formatGoalPace(seconds) {
  const total = Math.round(Number(seconds))
  if (!Number.isFinite(total) || total <= 0) return null
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}/mi`
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

function sessionTarget(session) {
  if (session.kind === 'lift') return String(session.prescription?.focus || 'Strength').replaceAll('_', ' ')
  if (session.prescriptionBasis === 'time' && session.durationMinutes > 0) return `${Math.round(session.durationMinutes)} min`
  if (session.distanceMiles > 0) return `${session.distanceIsEstimate ? '~' : ''}${session.distanceMiles.toFixed(1)} mi`
  return 'Run'
}

function sessionPurpose(session) {
  return session.prescription?.description
    || session.raw?.description
    || (session.kind === 'lift'
      ? 'Preserve strength and movement quality alongside the running block.'
      : 'Develop the fitness required for the plan goal at a controlled dose.')
}

function weekOverview(week, strengthEnabled) {
  const sessions = (week?.days || []).flatMap((day) => (
    (day.sessions || []).map((session) => ({ day, session }))
  ))
  const runs = sessions.filter(({ session }) => session.kind === 'run')
  const lifts = sessions.filter(({ session }) => session.kind === 'lift')
  const totalMiles = runs.reduce((sum, { session }) => sum + Number(session.distanceMiles || 0), 0)
  const longRun = runs
    .map(({ session }) => session)
    .filter((session) => ['long', 'race'].includes(String(session.type || '').toLowerCase()))
    .sort((left, right) => Number(right.distanceMiles || 0) - Number(left.distanceMiles || 0))[0]
  const restDays = (week?.days || []).filter((day) => day.isRest).length
  const phasePurpose = PHASE_PURPOSE[week?.phase] || 'Progress the plan with a repeatable balance of training and recovery.'
  return {
    sessions,
    summary: [
      `${runs.length} run${runs.length === 1 ? '' : 's'}`,
      strengthEnabled ? `${lifts.length} lift${lifts.length === 1 ? '' : 's'}` : null,
      totalMiles > 0 ? `${totalMiles.toFixed(1)} planned mi` : null,
      longRun ? `long ${sessionTarget(longRun)}` : null,
      `${restDays} rest day${restDays === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' · '),
    purpose: lifts.length
      ? `${phasePurpose} Strength work supports the run goal without replacing recovery.`
      : phasePurpose,
  }
}

function PlanOverview({ model, currentWeekIndex }) {
  return (
    <section className="forged-overview" aria-labelledby="forged-plan-overview-title">
      <div className="forged-overview-intro">
        <h3 id="forged-plan-overview-title">Plan overview</h3>
        <p>Review how every week and workout advances the goal. Open a week for the day-by-day purpose.</p>
      </div>
      <div className="forged-overview-weeks">
        {(model?.weeks || []).map((week, overviewIndex) => {
          const overview = weekOverview(week, model?.strengthEnabled)
          const resolvedWeekIndex = Number.isInteger(week.weekIndex) ? week.weekIndex : overviewIndex
          const isCurrent = resolvedWeekIndex === currentWeekIndex
          return (
            <details className="forged-overview-week" key={`overview-${resolvedWeekIndex}`} open={isCurrent}>
              <summary>
                <span className="forged-overview-week-main">
                  <span className="forged-overview-kicker">
                    Week {week.weekNumber} of {model.weekCount}{isCurrent ? ' · Current' : ''}
                  </span>
                  <strong>{String(week.phase || 'training').replace(/^./, (letter) => letter.toUpperCase())} focus</strong>
                  <span>{overview.summary}</span>
                </span>
                <ChevronDown size={18} aria-hidden="true" />
              </summary>
              <div className="forged-overview-week-body">
                <p className="forged-overview-purpose">{overview.purpose}</p>
                <ol className="forged-overview-sessions">
                  {overview.sessions.map(({ day, session }, sessionIndex) => (
                    <li key={`${day.dateISO || day.slot || resolvedWeekIndex}-${session.id || sessionIndex}`}>
                      <span className="forged-overview-session-head">
                        <span>{day.dayLabel}</span>
                        <strong>{session.title}</strong>
                        <span>{sessionTarget(session)}</span>
                      </span>
                      <p>{sessionPurpose(session)}</p>
                    </li>
                  ))}
                </ol>
              </div>
            </details>
          )
        })}
      </div>
    </section>
  )
}

function Stamp({ kind, state, small }) {
  const Icon = kind === 'lift' ? Dumbbell : kind === 'rest' ? Moon : Footprints
  return (
    <span
      className={`forged-stamp forged-stamp--${kind}${small ? ' forged-stamp--sm' : ''}`}
      data-state={state || undefined}
      aria-label={`${kind} ${state || ''}`.trim()}
    >
      <Icon size={small ? 12 : 15} />
    </span>
  )
}

function recordedRunSummary(activities = []) {
  if (!activities.length) return ''
  const totalMiles = activities.reduce((sum, activity) => sum + Number(activity.distanceMiles || 0), 0)
  const runLabel = activities.length === 1 ? 'Recorded run' : `${activities.length} recorded runs`
  return totalMiles > 0 ? `${runLabel} · ${totalMiles.toFixed(2)} mi` : runLabel
}

function WeekRow({ day, isToday, completedSet, recordedRuns = [], onOpen }) {
  const marks = dayMarks(day, completedSet)
  const status = dayStatus(day, completedSet)
  const runSession = day.sessions.find((s) => s.kind === 'run')
  const liftSession = day.sessions.find((s) => s.kind === 'lift')
  const hasRecordedRun = recordedRuns.length > 0
  const plannedIds = new Set(day.sessions.map((session) => String(session.id)))
  const unlinkedRun = recordedRuns.some((activity) => !activity.planSessionId || !plannedIds.has(String(activity.planSessionId)))
  const title = day.isRest && hasRecordedRun
    ? 'Recorded run'
    : day.isRest
    ? 'Rest day'
    : [runSession?.title, liftSession?.title].filter(Boolean).join(' + ') || 'Session'
  const runTarget = runSession?.prescriptionBasis === 'time' && runSession.durationMinutes > 0
    ? `${Math.round(runSession.durationMinutes)} min`
    : runSession && runSession.distanceMiles > 0
      ? `${runSession.distanceIsEstimate ? '~' : ''}${runSession.distanceMiles.toFixed(1)} mi`
      : (runSession ? 'Run' : '')
  const sub = day.isRest && hasRecordedRun
    ? `${recordedRunSummary(recordedRuns).replace(/^Recorded run · /, '')}${unlinkedRun ? ' · Not scheduled' : ''}`
    : day.isRest
    ? 'Recover'
    : [
        runTarget,
        liftSession ? 'Lift' : '',
      ].filter(Boolean).join(' · ')
  return (
    <button
      type="button"
      className="forged-day-row"
      data-today={isToday || undefined}
      data-rest={(day.isRest && !hasRecordedRun) || undefined}
      data-status={status}
      onClick={() => onOpen(day)}
    >
      <span className="forged-day-date">
        <span className="forged-day-dow">{day.dayLabel}</span>
        <span className="forged-day-num">{day.date ? day.date.getDate() : '–'}</span>
      </span>
      <span className="forged-day-main">
        <span className="forged-day-title">{title}</span>
        <span className="forged-day-sub">{sub || (isToday ? 'Today' : 'Planned')}</span>
        {!day.isRest && hasRecordedRun && (
          <span className="forged-day-recorded">{recordedRunSummary(recordedRuns)}{unlinkedRun ? ' · Not linked to plan' : ''}</span>
        )}
      </span>
      <span className="forged-day-stamps">
        {day.isRest && hasRecordedRun
          ? <Stamp kind="run" state="completed" small />
          : day.isRest
          ? <Stamp kind="rest" small />
          : marks.map((m) => <Stamp key={m.id} kind={m.kind} state={m.state} small />)}
      </span>
    </button>
  )
}

export default function ForgedCalendar({
  model,
  currentWeekIndex,
  weekCount,
  completedSet,
  todayISO,
  onPrevWeek,
  onNextWeek,
  onOpenDay,
  onEditGoal,
  recordedRunsByDate,
  canPrev,
  canNext,
}) {
  const [view, setView] = useState('week')
  const [monthAnchor, setMonthAnchor] = useState(() => {
    const week = model?.getWeek(currentWeekIndex)
    return week?.startISO || todayISO
  })
  const touchStartX = useRef(null)

  const week = model?.getWeek(currentWeekIndex) || null
  const goal = model?.goal || {}
  const phase = model?.phaseForWeek(currentWeekIndex)
  const countdown = goal.dateISO ? countdownDays(goal.dateISO, todayISO) : null
  const goalTimeLabel = formatGoalTime(goal.goalTimeSeconds)
  const goalPaceLabel = goal.goalPaceLabel || formatGoalPace(goal.goalPaceSecondsPerMile)
  const anchoredBy = goal.anchoredBy || null
  const anchorRunDate = formatAnchorRunDate(anchoredBy?.runDate)

  const monthGrid = useMemo(
    () => (view === 'month' ? buildMonthGrid(model, monthAnchor, { todayISO, completedSet, recordedRunsByDate }) : null),
    [view, model, monthAnchor, todayISO, completedSet, recordedRunsByDate],
  )

  const weekProgress = useMemo(() => {
    const sessions = (week?.days || []).flatMap((day) => day.sessions || [])
    const total = sessions.length
    const completed = sessions.filter((session) => completedSet?.has(String(session.id))).length
    return { total, completed, percent: total ? Math.round((completed / total) * 100) : 0 }
  }, [week, completedSet])

  const handleTouchStart = (event) => { touchStartX.current = event.touches[0]?.clientX ?? null }
  const handleTouchEnd = (event) => {
    if (touchStartX.current === null) return
    const delta = (event.changedTouches[0]?.clientX ?? 0) - touchStartX.current
    if (Math.abs(delta) > 60) {
      if (delta < 0 && canNext) onNextWeek()
      else if (delta > 0 && canPrev) onPrevWeek()
    }
    touchStartX.current = null
  }

  return (
    <div className="forged-cal">
      {/* Header */}
      <div className="rounded-lg p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <div className="forged-cal-header">
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              {typeof onEditGoal === 'function' ? (
                <button type="button" onClick={onEditGoal} aria-label={`Edit ${goal.name || 'upcoming race'}`} title="Edit upcoming race" style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: 0, border: 0, background: 'transparent', color: 'var(--text-primary)', textAlign: 'left' }}>
                  <h2 className="text-lg font-bold" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{goal.name || 'Training plan'}</h2>
                  <span style={{ flex: '0 0 auto', width: 32, height: 32, display: 'grid', placeItems: 'center', borderRadius: 8, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--accent)' }}><Pencil size={15} /></span>
                </button>
              ) : (
                <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{goal.name || 'Training plan'}</h2>
              )}
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {[
                phase ? `${phase} phase` : null,
                model?.modeLabel,
                Number.isFinite(countdown) && countdown >= 0 ? `${countdown} days to go` : null,
              ].filter(Boolean).join(' · ')}
            </p>
            {goalTimeLabel && goalPaceLabel && (
              <p className="text-xs mt-1 font-bold" style={{ color: 'var(--accent)' }}>
                {goal.goalTimeSource === 'performance_anchor' ? 'Auto target' : 'Goal'} {goalTimeLabel} · {goalPaceLabel}
              </p>
            )}
            {anchoredBy && anchorRunDate && (
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Target set from your {anchorRunDate} run
              </p>
            )}
            {['stretch', 'build'].includes(goal.paceContext?.status) && (
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                {goal.paceContext.status === 'stretch'
                  ? 'Stretch target · confirm with a controlled benchmark as the plan progresses.'
                  : 'Progression target · race-specific work builds toward this pace.'}
              </p>
            )}
          </div>
          <div className="forged-seg forged-seg--calendar" role="group" aria-label="Plan view">
            <button type="button" aria-pressed={view === 'week'} onClick={() => setView('week')}>Week</button>
            <button type="button" aria-pressed={view === 'overview'} onClick={() => setView('overview')}>Overview</button>
            <button type="button" aria-pressed={view === 'month'} onClick={() => {
              setMonthAnchor(week?.startISO || todayISO)
              setView('month')
            }}>Month</button>
          </div>
        </div>
        {(model?.goals || []).length > 1 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" style={{ marginTop: 12 }} aria-label="Protected race goals">
            {model.goals.map((raceGoal, index) => (
              <div key={raceGoal.raceId || raceGoal.dateISO} className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                <p className="text-[10px] font-black uppercase" style={{ color: 'var(--accent)', margin: 0 }}>A{index + 1} · {raceGoal.role === 'final_peak' ? 'Final peak' : 'First peak'}</p>
                <p className="text-sm font-bold" style={{ color: 'var(--text-primary)', margin: '4px 0 0' }}>{raceGoal.name}</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)', margin: '3px 0 0' }}>
                  {formatAnchorRunDate(raceGoal.dateISO)} · {Number(raceGoal.distanceMiles || 0).toFixed(1)} mi
                  {raceGoal.goalTimeSeconds ? ` · ${formatGoalTime(raceGoal.goalTimeSeconds)}` : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {view === 'week' && (
        <div style={{ marginTop: 12 }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
            <button
              type="button"
              onClick={onPrevWeek}
              disabled={!canPrev}
              aria-label="Previous week"
              className="rounded-lg"
              style={{ width: 40, height: 40, display: 'grid', placeItems: 'center', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', opacity: canPrev ? 1 : 0.4 }}
            >
              <ChevronLeft size={18} />
            </button>
            <div style={{ flex: 1, maxWidth: 180, textAlign: 'center', padding: '0 8px' }}>
              <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                Week {week?.weekNumber || currentWeekIndex + 1}{weekCount ? ` of ${weekCount}` : ''}
              </span>
              {weekProgress.total > 0 && (
                <>
                  <div
                    role="progressbar"
                    aria-label="Weekly workout completion"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    aria-valuenow={weekProgress.percent}
                    style={{ height: 4, marginTop: 5, borderRadius: 4, overflow: 'hidden', background: 'var(--bg-input)' }}
                  >
                    <div style={{ width: `${weekProgress.percent}%`, height: '100%', background: 'var(--success)', borderRadius: 4 }} />
                  </div>
                  <span style={{ display: 'block', marginTop: 3, color: 'var(--text-muted)', fontSize: 10, fontWeight: 700 }}>
                    {weekProgress.percent}% complete this week
                  </span>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={onNextWeek}
              disabled={!canNext}
              aria-label="Next week"
              className="rounded-lg"
              style={{ width: 40, height: 40, display: 'grid', placeItems: 'center', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', opacity: canNext ? 1 : 0.4 }}
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <div
            className="forged-week"
            data-swipe-back-ignore
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            {(week?.days || []).map((day) => (
              <WeekRow
                key={day.dateISO || `${week?.weekIndex}-${day.slot}`}
                day={day}
                isToday={day.dateISO === todayISO}
                completedSet={completedSet}
                recordedRuns={recordedRunsByDate?.get(day.dateISO) || []}
                onOpen={onOpenDay}
              />
            ))}
          </div>
        </div>
      )}

      {view === 'overview' && (
        <PlanOverview model={model} currentWeekIndex={currentWeekIndex} />
      )}

      {view === 'month' && monthGrid && (
        <div style={{ marginTop: 12 }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
            <button
              type="button"
              onClick={() => setMonthAnchor((iso) => addMonths(iso, -1))}
              aria-label="Previous month"
              className="rounded-lg"
              style={{ width: 40, height: 40, display: 'grid', placeItems: 'center', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
            >
              <ChevronLeft size={18} />
            </button>
            <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{monthGrid.monthLabel}</span>
            <button
              type="button"
              onClick={() => setMonthAnchor((iso) => addMonths(iso, 1))}
              aria-label="Next month"
              className="rounded-lg"
              style={{ width: 40, height: 40, display: 'grid', placeItems: 'center', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <div className="forged-month">
            <div className="forged-month-head">
              {MONTH_DOW.map((label, index) => (
                <span key={`${WEEKDAYS[index]}-dow`} className="forged-month-dow">{label}</span>
              ))}
            </div>
            {monthGrid.rows.map((row, rowIndex) => (
              <div className="forged-month-week" key={`mw-${rowIndex}`}>
                {row.map((cell) => (
                  <button
                    type="button"
                    key={cell.dateISO}
                    className="forged-month-cell"
                    data-out={!cell.inMonth || undefined}
                    data-today={cell.isToday || undefined}
                    data-state={cell.state || undefined}
                    onClick={() => {
                      const day = model?.findDayByDate(cell.dateISO)
                      if (day || cell.hasRecordedRun) onOpenDay(day || { dateISO: cell.dateISO })
                    }}
                    aria-label={`${cell.dateISO}${cell.mark ? ` ${cell.mark}` : ''}`}
                  >
                    <span className="forged-month-num">{cell.dayOfMonth}</span>
                    <span className="forged-month-marks">
                      {cell.mark === 'hybrid' && <span className="forged-mark-dot forged-mark-dot--hybrid" />}
                      {cell.mark === 'run' && <span className="forged-mark-dot forged-mark-dot--run" />}
                      {cell.mark === 'lift' && <span className="forged-mark-dot forged-mark-dot--lift" />}
                      {cell.mark === 'rest' && <span className="forged-mark-dot forged-mark-dot--rest" />}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
