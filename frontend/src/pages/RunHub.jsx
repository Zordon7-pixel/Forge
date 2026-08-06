import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Accessibility, CalendarDays, ChevronRight, Flame, HeartPulse, History, Lightbulb, Medal } from 'lucide-react'
import { useUnits } from '../context/UnitsContext'
import api from '../lib/api'
import { getPaceZone } from '../lib/athleteLanguage'
import AiGuidanceNote from '../components/AiGuidanceNote'
import { fetchDailyExecution, recommendationFromExecution, runRouteState } from '../lib/dailyExecution'
import { getSmartQuickAction } from '../lib/smartQuickAction'

const SMART_ACTION_ICONS = {
  calendar: CalendarDays,
  history: History,
  body: HeartPulse,
  prs: Medal,
}

export default function RunHub() {
  const { fmt } = useUnits()
  const [latestRun, setLatestRun] = useState(null)
  const [recommendation, setRecommendation] = useState(null)
  const [execution, setExecution] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      api.get('/runs'),
      fetchDailyExecution().catch((err) => {
        console.error('[RunHub] canonical daily execution fetch failed:', err?.message || err)
        return null
      }),
      api.get('/runs/next-recommendation').catch(() => ({ data: null })),
    ])
      .then(([runsRes, dailyExecution, recRes]) => {
        const runs = Array.isArray(runsRes.data) ? runsRes.data : runsRes.data?.runs || []
        setLatestRun(runs[0] || null)
        setExecution(dailyExecution)
        setRecommendation(dailyExecution?.hasPlan
          ? recommendationFromExecution(dailyExecution)
          : (recRes.data || null))
      })
      .catch((err) => {
        console.error('[RunHub] failed to load run hub:', err?.message || err)
        setLatestRun(null)
        setRecommendation(null)
        setExecution(null)
      })
      .finally(() => setLoading(false))
  }, [])

  const paceZone = useMemo(() => {
    if (!latestRun?.duration_seconds || !latestRun?.distance_miles) return null
    const paceMinPerMile = latestRun.duration_seconds / 60 / latestRun.distance_miles
    return getPaceZone(paceMinPerMile)
  }, [latestRun])

  const paceText = useMemo(() => {
    if (!latestRun?.duration_seconds || !latestRun?.distance_miles) return '--'
    return fmt.pace(latestRun.duration_seconds / latestRun.distance_miles)
  }, [latestRun, fmt])

  const calendarOwnsToday = execution?.hasPlan === true
  const calendarRunState = useMemo(() => runRouteState(execution), [execution])
  const smartAction = useMemo(() => getSmartQuickAction(), [])
  const SmartActionIcon = SMART_ACTION_ICONS[smartAction.icon] || History

  const recommendationTarget = useMemo(() => {
    if (!recommendation) return calendarOwnsToday ? '/plan' : '/log-run'
    if (recommendation.recommendationType === 'strength') return '/log-lift'
    if (recommendation.recommendationType === 'rest') return '/plan'
    if (recommendation.source === 'calendar') return '/log-run'
    const params = new URLSearchParams()
    if (Number(recommendation.suggestedDistance || 0) > 0) params.set('distance', String(recommendation.suggestedDistance))
    if (recommendation.recommendationType) params.set('type', String(recommendation.recommendationType))
    if (recommendation.suggestedPace) params.set('pace', String(recommendation.suggestedPace))
    return `/log-run${params.toString() ? `?${params.toString()}` : ''}`
  }, [calendarOwnsToday, recommendation])

  return (
    <div className="space-y-4 py-2">
      <header className="px-1 py-1">
        <h1 className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>Train</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>Today&apos;s run and the weeks ahead.</p>
      </header>

      <Link
        to="/plan"
        className="flex items-center justify-between gap-3 rounded-2xl p-4"
        style={{ background: 'var(--accent)', color: 'var(--on-accent)', textDecoration: 'none' }}
      >
        <span className="flex items-center gap-3 text-left">
          <CalendarDays size={22} />
          <span>
            <span className="block text-base font-black">{calendarOwnsToday ? 'Open training plan' : 'Create a training plan'}</span>
            <span className="mt-0.5 block text-xs font-semibold opacity-80">{calendarOwnsToday ? 'Review today and the weeks ahead.' : 'Choose your goal, training days, and timeline.'}</span>
          </span>
        </span>
        <ChevronRight size={20} className="shrink-0" />
      </Link>

      {loading && (
        <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
          <p style={{ color: 'var(--text-muted)' }}>Loading run stats...</p>
        </div>
      )}

      {!loading && !latestRun && (
        <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
          <div>
            <p className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>First run sets your baseline</p>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>Warm up, log the run, then Forged Hybrid will translate your pace and adjust the next recommendation.</p>
            <div className="mt-3">
              <Link to="/log-run" className="block rounded-xl py-2 text-center text-sm font-semibold" style={{ background: 'var(--accent)', color: 'var(--on-accent)', textDecoration: 'none' }}>
                Log Run
              </Link>
            </div>
          </div>
        </div>
      )}

      {recommendation && (
        <Link
          to={recommendationTarget}
          state={recommendation.source === 'calendar' ? calendarRunState : undefined}
          className="block rounded-2xl p-4"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', textDecoration: 'none' }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Lightbulb size={15} color="var(--accent)" />
              <p className="text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>
                {recommendation.source === 'calendar' ? 'Today\'s Plan' : 'Today\'s Recommendation'}
              </p>
            </div>
            <ChevronRight size={15} color="var(--text-muted)" />
          </div>
          <p className="text-sm font-bold mt-2 capitalize" style={{ color: 'var(--text-primary)' }}>
            {String(recommendation.recommendationType || '').replace('_', ' ')}
            {Number(recommendation.suggestedDistance || 0) > 0 ? ` · ${recommendation.suggestedDistance} mi` : ''}
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{recommendation.reason}</p>
          {recommendation.reason && recommendation.recommendationType !== 'rest' && <AiGuidanceNote />}
        </Link>
      )}

      {!loading && calendarOwnsToday && !recommendation && (
        <Link
          to="/plan"
          className="block rounded-2xl p-4"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', textDecoration: 'none' }}
        >
          <p className="text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>Today&apos;s Plan</p>
          <p className="text-sm font-bold mt-2" style={{ color: 'var(--text-primary)' }}>No run is scheduled today</p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Open your calendar to review the next session.</p>
        </Link>
      )}

      {latestRun && (
        <details className="rounded-2xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
          <summary className="pressable flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
            <span className="min-w-0">
              <span className="block text-[10px] font-black uppercase" style={{ color: 'var(--text-muted)' }}>Recent run</span>
              <span className="mt-1 block truncate text-lg font-black" style={{ color: 'var(--text-primary)' }}>
                {paceText}
                {paceZone && <span style={{ color: paceZone.textColor || paceZone.color }}> · Zone {paceZone.zone} {paceZone.label}</span>}
              </span>
            </span>
            <ChevronRight size={18} color="var(--text-muted)" className="shrink-0" />
          </summary>
          <div className="border-t px-4 pb-4 pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
            {paceZone && <p className="mb-3 text-sm" style={{ color: paceZone.textColor || paceZone.color }}>{paceZone.description}</p>}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl p-2 text-center" style={{ background: 'var(--bg-input)' }}>
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Distance</p>
                <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{fmt.distance(Number(latestRun.distance_miles || 0), 2)}</p>
              </div>
              <div className="rounded-xl p-2 text-center" style={{ background: 'var(--bg-input)' }}>
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Duration</p>
                <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{Math.round(Number(latestRun.duration_seconds || 0) / 60)} min</p>
              </div>
              <div className="rounded-xl p-2 text-center" style={{ background: 'var(--bg-input)' }}>
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Effort</p>
                <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{latestRun.perceived_effort ? `${latestRun.perceived_effort}/10` : '--'}</p>
              </div>
            </div>
          </div>
        </details>
      )}

      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <p className="text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>Quick Actions</p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Link to="/warmup" className="flex min-h-[76px] flex-col items-center justify-center gap-2 rounded-xl px-1.5 py-2 text-center text-xs font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', textDecoration: 'none' }}>
            <Flame size={19} color="var(--accent)" />
            <span>Start Warm-Up</span>
          </Link>
          <Link to="/stretches" className="flex min-h-[76px] flex-col items-center justify-center gap-2 rounded-xl px-1.5 py-2 text-center text-xs font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', textDecoration: 'none' }}>
            <Accessibility size={19} color="var(--accent)" />
            <span>Start Stretches</span>
          </Link>
          <Link to={smartAction.path} className="flex min-h-[76px] flex-col items-center justify-center gap-2 rounded-xl px-1.5 py-2 text-center text-xs font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', textDecoration: 'none' }}>
            <SmartActionIcon size={19} color="var(--accent)" />
            <span>{smartAction.label}</span>
          </Link>
        </div>
      </div>

      <Link
        to="/log-run"
        className="block w-full rounded-xl py-3 text-center text-sm font-black"
        style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)', textDecoration: 'none' }}
      >
        Log a run manually
      </Link>
    </div>
  )
}
