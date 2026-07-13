import { useMemo, useRef, useState } from 'react'
import {
  Footprints, Dumbbell, Moon, ChevronLeft, ChevronRight, ChevronRight as OpenIcon,
} from 'lucide-react'
import {
  buildMonthGrid, addMonths, dayMarks, dayStatus, countdownDays, WEEKDAYS,
} from '../../lib/planCalendar'
import './forgedCalendar.css'

const MONTH_DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

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
  const sub = day.isRest
    ? 'Recover'
    : [
        runSession && runSession.distanceMiles > 0 ? `${runSession.distanceMiles.toFixed(1)} mi` : (runSession ? 'Run' : ''),
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

  const monthGrid = useMemo(
    () => (view === 'month' ? buildMonthGrid(model, monthAnchor, { todayISO, completedSet }) : null),
    [view, model, monthAnchor, todayISO, completedSet],
  )

  const todayInWeek = useMemo(
    () => (week ? week.days.find((d) => d.dateISO === todayISO) : null),
    [week, todayISO],
  )

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
            <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
              Week {week?.weekNumber || currentWeekIndex + 1}{weekCount ? ` of ${weekCount}` : ''}
            </span>
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
