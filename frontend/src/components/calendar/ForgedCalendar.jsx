import { useMemo, useRef, useState } from 'react'
import {
  Footprints, Dumbbell, Moon, ChevronLeft, ChevronRight, ChevronRight as OpenIcon,
} from 'lucide-react'
import {
  buildMonthGrid, addMonths, dayMarks, dayStatus, countdownDays, WEEKDAYS,
} from '../../lib/planCalendar'
import './forgedCalendar.css'

const MONTH_DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

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

function performanceSourceLabel(source) {
  if (source === 'apple_health+strava') return 'Apple Health + Strava'
  if (source === 'apple_health') return 'Apple Health'
  if (source === 'strava') return 'Strava'
  return 'run history'
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

function WeekRow({ day, isToday, completedSet, onOpen }) {
  const marks = dayMarks(day, completedSet)
  const status = dayStatus(day, completedSet)
  const runSession = day.sessions.find((s) => s.kind === 'run')
  const liftSession = day.sessions.find((s) => s.kind === 'lift')
  const title = day.isRest
    ? 'Rest day'
    : [runSession?.title, liftSession?.title].filter(Boolean).join(' + ') || 'Session'
  const runTarget = runSession?.prescriptionBasis === 'time' && runSession.durationMinutes > 0
    ? `${Math.round(runSession.durationMinutes)} min`
    : runSession && runSession.distanceMiles > 0
      ? `${runSession.distanceIsEstimate ? '~' : ''}${runSession.distanceMiles.toFixed(1)} mi`
      : (runSession ? 'Run' : '')
  const sub = day.isRest
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
      data-rest={day.isRest || undefined}
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
      </span>
      <span className="forged-day-stamps">
        {day.isRest
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
  onOpenToday,
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
  const performanceAnchor = goal.paceContext?.performanceAnchor || null

  const monthGrid = useMemo(
    () => (view === 'month' ? buildMonthGrid(model, monthAnchor, { todayISO, completedSet }) : null),
    [view, model, monthAnchor, todayISO, completedSet],
  )

  const todayInWeek = useMemo(
    () => (week ? week.days.find((d) => d.dateISO === todayISO) : null),
    [week, todayISO],
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
        <div className="flex items-start justify-between gap-3">
          <div style={{ minWidth: 0 }}>
            <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {goal.name || 'Training plan'}
            </h2>
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
            {performanceAnchor && (
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                {performanceAnchor.kind === 'cross_distance_estimate' ? 'Estimated from' : 'Benchmark'}{' '}
                {performanceAnchor.observedDistanceMiles} mi at {performanceAnchor.observedPaceLabel} · {performanceSourceLabel(performanceAnchor.source)}
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
          <div className="forged-seg" role="group" aria-label="Calendar view">
            <button type="button" aria-pressed={view === 'week'} onClick={() => setView('week')}>Week</button>
            <button type="button" aria-pressed={view === 'month'} onClick={() => {
              setMonthAnchor(week?.startISO || todayISO)
              setView('month')
            }}>Month</button>
          </div>
        </div>
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
                onOpen={onOpenDay}
              />
            ))}
          </div>

          {todayInWeek && (
            <button type="button" className="forged-today-cta" style={{ marginTop: 12 }} onClick={() => onOpenToday(todayInWeek)}>
              Open today <OpenIcon size={16} style={{ verticalAlign: -3 }} />
            </button>
          )}
        </div>
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
                      if (day) onOpenDay(day)
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
