import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronUp } from 'lucide-react'
import api from '../lib/api'
import { useProContext } from '../context/ProContext'
import ProGate from '../components/ProGate'
import ForgedCalendar from '../components/calendar/ForgedCalendar'
import ForgedDayView from '../components/calendar/ForgedDayView'
import { buildCalendarModel, todayISO } from '../lib/planCalendar'

const RUN_DAY_OPTIONS = [
  { key: 'Mon', label: 'M' },
  { key: 'Tue', label: 'T' },
  { key: 'Wed', label: 'W' },
  { key: 'Thu', label: 'T' },
  { key: 'Fri', label: 'F' },
  { key: 'Sat', label: 'S' },
  { key: 'Sun', label: 'S' },
]

export default function Plan() {
  const navigate = useNavigate()
  const { isPro, loading: proLoading } = useProContext()
  const [plans, setPlans] = useState([])
  const [myPlan, setMyPlan] = useState(null)
  const [myUserPlan, setMyUserPlan] = useState(null)
  const [adaptivePlan, setAdaptivePlan] = useState(null)
  const [adaptiveLoading, setAdaptiveLoading] = useState(false)
  const [acceptingAdaptive, setAcceptingAdaptive] = useState(false)
  const [loading, setLoading] = useState(true)
  const [assigningId, setAssigningId] = useState(null)
  const [updating, setUpdating] = useState(false)
  const [preferredRunDays, setPreferredRunDays] = useState(['Tue', 'Thu', 'Sat'])
  const [runDaysPerWeek, setRunDaysPerWeek] = useState(3)
  const [selectedDayISO, setSelectedDayISO] = useState(null)
  const [manageOpen, setManageOpen] = useState(false)

  const adaptiveParams = useMemo(() => ({
    run_days_per_week: runDaysPerWeek,
    preferred_run_days: preferredRunDays.join(','),
  }), [preferredRunDays, runDaysPerWeek])

  const loadAll = async (params = adaptiveParams) => {
    setLoading(true)
    setAdaptiveLoading(true)
    try {
      const [plansRes, myRes, adaptiveRes] = await Promise.all([
        api.get('/plans'),
        api.get('/plans/my'),
        api.get('/plans/adaptive/recommend', { params }).catch(() => ({ data: null })),
      ])
      setPlans(plansRes.data?.plans || [])
      setMyPlan(myRes.data?.plan || null)
      setMyUserPlan(myRes.data?.user_plan || null)
      setAdaptivePlan(adaptiveRes?.data || null)
    } finally {
      setLoading(false)
      setAdaptiveLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adaptiveParams])

  const togglePreferredRunDay = (day) => {
    setPreferredRunDays((prev) => {
      const next = prev.includes(day) ? prev.filter((item) => item !== day) : [...prev, day]
      return next.sort((a, b) => RUN_DAY_OPTIONS.findIndex((item) => item.key === a) - RUN_DAY_OPTIONS.findIndex((item) => item.key === b))
    })
  }

  const assignPlan = async (planId) => {
    setAssigningId(planId)
    try {
      await api.post(`/plans/assign/${planId}`)
      await loadAll()
    } finally {
      setAssigningId(null)
    }
  }

  const currentWeek = Math.max(1, Number(myUserPlan?.current_week || 1))
  const weekIndex = currentWeek - 1
  const today = todayISO()
  const completedSet = useMemo(
    () => new Set((myUserPlan?.progress?.completedSessionIds || []).map(String)),
    [myUserPlan],
  )

  const model = useMemo(
    () => (myPlan ? buildCalendarModel(myPlan, myUserPlan) : null),
    [myPlan, myUserPlan],
  )
  const weekCount = Number(myPlan?.weeks || model?.weekCount || 0)

  // Derive the selected day from the live model so completion toggles stay fresh
  // across reloads (we store the ISO date, not a stale day object).
  const selectedDay = useMemo(
    () => (selectedDayISO && model ? model.findDayByDate(selectedDayISO) : null),
    [selectedDayISO, model],
  )
  const selectedPhase = useMemo(() => {
    if (!selectedDay || !model) return null
    return model.phaseForWeek(selectedDay.weekIndex)
  }, [selectedDay, model])

  const toggleSession = async (sessionId) => {
    if (!sessionId) return
    const isCompleted = completedSet.has(String(sessionId))
    setUpdating(true)
    try {
      await api.put('/plans/my/progress', isCompleted
        ? { unset_session_id: sessionId, current_week: currentWeek }
        : { completed_session_id: sessionId, current_week: currentWeek })
      await loadAll()
    } finally {
      setUpdating(false)
    }
  }

  const goToWeek = async (nextWeek) => {
    setUpdating(true)
    try {
      await api.put('/plans/my/progress', { current_week: nextWeek })
      await loadAll()
    } finally {
      setUpdating(false)
    }
  }

  const acceptAdaptive = async () => {
    setAcceptingAdaptive(true)
    try {
      await api.post('/plans/adaptive/accept', adaptiveParams)
      await loadAll()
    } finally {
      setAcceptingAdaptive(false)
    }
  }

  const intensityMeta = useMemo(() => {
    const key = String(adaptivePlan?.intensity || 'normal').toLowerCase()
    if (key === 'recovery') return { label: '🔴 Recovery', color: 'var(--danger)' }
    if (key === 'reduced') return { label: '🟡 Reduced', color: 'var(--accent)' }
    if (key === 'increased') return { label: '💪 Increased', color: 'var(--success)' }
    return { label: '🟢 Normal', color: '#16A34A' }
  }, [adaptivePlan?.intensity])

  if (loading) {
    return (
      <ProGate isPro={isPro} loading={proLoading} message="AI Training Plans are a Pro feature">
        <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>Loading training plans...</div>
      </ProGate>
    )
  }

  // Adaptive recommendation panel — kept reachable per migration rule #10.
  const adaptivePanel = (
    <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>Adaptive recommendation</h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>This week&apos;s suggested adjustment from your check-ins.</p>
        </div>
        <span className="text-xs font-bold rounded-full px-3 py-1" style={{ background: 'var(--bg-input)', color: intensityMeta.color }}>{intensityMeta.label}</span>
      </div>
      {adaptiveLoading && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading adaptive recommendation...</p>}
      {!adaptiveLoading && !adaptivePlan && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Adaptive recommendation is not available yet.</p>}
      {!adaptiveLoading && adaptivePlan && (
        <>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{adaptivePlan.reason || adaptivePlan.recommendation}</p>
          <div className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Run availability</p>
            <div className="mt-3 grid grid-cols-5 gap-2">
              {[2, 3, 4, 5, 6].map((count) => (
                <button key={count} type="button" onClick={() => setRunDaysPerWeek(count)} className="rounded-lg px-2 py-2 text-xs font-black"
                  style={{ border: `1px solid ${runDaysPerWeek === count ? 'var(--accent)' : 'var(--border-subtle)'}`, background: runDaysPerWeek === count ? 'var(--accent)' : 'var(--bg-card)', color: runDaysPerWeek === count ? '#000' : 'var(--text-primary)' }}>
                  {count}d
                </button>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-7 gap-2">
              {RUN_DAY_OPTIONS.map((day) => {
                const active = preferredRunDays.includes(day.key)
                return (
                  <button key={day.key} type="button" onClick={() => togglePreferredRunDay(day.key)} className="rounded-lg py-2 text-xs font-black"
                    style={{ border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`, background: active ? 'var(--accent-dim)' : 'var(--bg-card)', color: active ? 'var(--accent)' : 'var(--text-muted)' }}
                    aria-label={`Prefer ${day.key} runs`}>
                    {day.label}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(adaptivePlan.sessions || []).map((session, index) => (
              <div key={session.id || `${session.day}-${index}`} className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                <p className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>{session.day}</p>
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{session.title}</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {session.type === 'run' && Number(session.distance_miles || 0) > 0
                    ? `${Number(session.distance_miles).toFixed(1)} mi`
                    : session.type === 'rest' ? 'Rest day' : 'Strength session'}
                </p>
              </div>
            ))}
          </div>
          <button onClick={acceptAdaptive} disabled={acceptingAdaptive} className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
            {acceptingAdaptive ? 'Saving...' : 'Accept adjustment'}
          </button>
        </>
      )}
    </div>
  )

  return (
    <ProGate isPro={isPro} loading={proLoading} message="AI Training Plans are a Pro feature">
      <div className="space-y-4">
        {/* No active plan: catalog assignment + adaptive controls stay reachable */}
        {!myPlan && (
          <>
            <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
              <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Training Plans</h2>
              <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Run-only or hybrid plans. When lifting is on, strength is a protected training objective alongside your race goal.</p>
            </div>
            <div className="grid gap-3">
              {plans.map((plan) => (
                <div key={plan.id} className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                  <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{plan.name}</p>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{plan.type} · {plan.weeks} weeks</p>
                  <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>{plan.description}</p>
                  <button onClick={() => assignPlan(plan.id)} disabled={assigningId === plan.id} className="mt-3 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
                    {assigningId === plan.id ? 'Assigning...' : 'Assign Plan'}
                  </button>
                </div>
              ))}
            </div>
            {adaptivePanel}
          </>
        )}

        {/* Active plan: the Forged Training Calendar is primary */}
        {myPlan && model && (
          selectedDay ? (
            <ForgedDayView
              day={selectedDay}
              planContext={{ goal: model.goal, mode: model.mode, modeLabel: model.modeLabel, phase: selectedPhase }}
              completedSet={completedSet}
              onToggleComplete={toggleSession}
              onStartRun={() => navigate('/warmup')}
              onStartLift={() => navigate('/log-lift')}
              onBack={() => setSelectedDayISO(null)}
              updating={updating}
            />
          ) : (
            <>
              <ForgedCalendar
                model={model}
                currentWeekIndex={weekIndex}
                weekCount={weekCount}
                completedSet={completedSet}
                todayISO={today}
                onPrevWeek={() => goToWeek(Math.max(1, currentWeek - 1))}
                onNextWeek={() => goToWeek(Math.min(weekCount || currentWeek, currentWeek + 1))}
                onOpenDay={(day) => setSelectedDayISO(day.dateISO)}
                onOpenToday={(day) => setSelectedDayISO(day.dateISO)}
                canPrev={currentWeek > 1 && !updating}
                canNext={currentWeek < (weekCount || currentWeek) && !updating}
              />

              {/* Secondary plan controls in a compact Manage plan disclosure */}
              <div className="rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                <button type="button" onClick={() => setManageOpen((v) => !v)}
                  className="w-full flex items-center justify-between p-4"
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}
                  aria-expanded={manageOpen}>
                  <span className="text-sm font-bold">Manage plan</span>
                  {manageOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </button>
                {manageOpen && (
                  <div className="p-4 pt-0 space-y-3">
                    <div className="rounded-lg p-3" style={{ background: 'var(--bg-input)' }}>
                      <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{myPlan.name}</p>
                      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{myPlan.type} · Week {currentWeek} of {myPlan.weeks}</p>
                    </div>
                    {adaptivePanel}
                    <button onClick={() => { setSelectedDayISO(null); setMyPlan(null); setMyUserPlan(null) }}
                      className="rounded-lg px-4 py-2 text-sm font-semibold"
                      style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
                      Change Plan
                    </button>
                  </div>
                )}
              </div>
            </>
          )
        )}
      </div>
    </ProGate>
  )
}
