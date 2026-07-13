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
  const [adaptationProposal, setAdaptationProposal] = useState(null)
  const [adaptationLoading, setAdaptationLoading] = useState(false)
  const [adaptationError, setAdaptationError] = useState('')
  const [adaptationDecision, setAdaptationDecision] = useState(null)
  const [decidingAdaptation, setDecidingAdaptation] = useState(null)
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
    setAdaptationLoading(true)
    setAdaptationError('')
    try {
      const [plansRes, myRes] = await Promise.all([
        api.get('/plans'),
        api.get('/plans/my'),
      ])
      const nextPlan = myRes.data?.plan || null
      setPlans(plansRes.data?.plans || [])
      setMyPlan(nextPlan)
      setMyUserPlan(myRes.data?.user_plan || null)
      const isSchemaV2 = Number(nextPlan?.plan_data?.schemaVersion || 0) === 2
      if (isSchemaV2) {
        setAdaptivePlan(null)
        setAdaptiveLoading(false)
        try {
          const adaptationRes = await api.get('/plans/adaptation/current', { params: { date: todayISO() } })
          setAdaptationProposal(adaptationRes.data?.proposal || null)
        } catch (err) {
          setAdaptationProposal(null)
          setAdaptationError(err?.response?.data?.error || 'Transparent adjustment is not available right now.')
        }
      } else if (!nextPlan) {
        setAdaptationProposal(null)
        setAdaptationLoading(false)
        const adaptiveRes = await api.get('/plans/adaptive/recommend', { params }).catch(() => ({ data: null }))
        setAdaptivePlan(adaptiveRes?.data || null)
      } else {
        setAdaptationProposal(null)
        setAdaptationLoading(false)
        const adaptiveRes = await api.get('/plans/adaptive/recommend', { params }).catch(() => ({ data: null }))
        setAdaptivePlan(adaptiveRes?.data || null)
      }
    } finally {
      setLoading(false)
      setAdaptiveLoading(false)
      setAdaptationLoading(false)
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
  const isActiveSchemaV2 = Number(myPlan?.plan_data?.schemaVersion || 0) === 2
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

  const decideAdaptation = async (decision) => {
    if (!adaptationProposal?.id) return
    setDecidingAdaptation(decision)
    setAdaptationError('')
    try {
      await api.post(`/plans/adaptation/${adaptationProposal.id}/${decision}`)
      if (decision === 'accept') {
        await loadAll()
        setAdaptationDecision('accepted')
      } else {
        setAdaptationProposal((prev) => prev ? { ...prev, decisionStatus: 'kept' } : prev)
        setAdaptationDecision('kept')
      }
    } catch (err) {
      setAdaptationError(err?.response?.data?.error || 'Could not update this adjustment.')
    } finally {
      setDecidingAdaptation(null)
    }
  }

  const formatEvidenceSource = (source) => {
    if (source === 'apple_health') return 'Apple Health'
    if (source === 'checkin') return 'Check-in'
    if (source === 'completion') return 'Completion'
    if (source === 'injury') return 'Injury'
    return source || 'Signal'
  }

  const formatSession = (session = {}) => {
    const title = session.title || session.type || session.workout_type || session.kind || 'Session'
    const miles = Number(session.distance_miles ?? session.distance ?? session.miles)
    const duration = Number(session.duration_min ?? session.duration_minutes ?? session.minutes)
    const pieces = [title]
    if (Number.isFinite(miles) && miles > 0) pieces.push(`${Math.round(miles * 10) / 10} mi`)
    else if (Number.isFinite(duration) && duration > 0) pieces.push(`${Math.round(duration)} min`)
    if (session.intensity) pieces.push(session.intensity)
    return pieces.join(' · ')
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

  const course = model?.goal?.course || myPlan?.plan_data?.goal?.course || null
  const hasVerifiedCourse = course
    && ['official', 'curated'].includes(String(course.provenance || '').toLowerCase())
    && (course.source || course.url)
  const hasAdaptationChanges = adaptationProposal?.status === 'proposal'
    && (adaptationProposal?.changes || []).length > 0
    && adaptationProposal?.decisionStatus !== 'kept'
    && adaptationProposal?.decisionStatus !== 'accepted'

  const adaptationPanel = isActiveSchemaV2 ? (
    <div className="rounded-lg p-4 space-y-3 min-w-0" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 min-w-0">
        <div className="min-w-0">
          <h2 className="text-base font-bold break-words" style={{ color: 'var(--text-primary)' }}>
            {adaptationProposal?.headline || 'Transparent adjustment'}
          </h2>
          <p className="text-sm mt-1 break-words" style={{ color: 'var(--text-muted)' }}>
            {adaptationLoading ? 'Checking the live calendar...' : adaptationProposal?.reason || 'No calendar adjustment is pending.'}
          </p>
        </div>
        {adaptationProposal?.safetyException && (
          <span className="text-xs font-bold rounded-full px-3 py-1 self-start" style={{ background: 'var(--danger-dim)', color: 'var(--danger)' }}>
            Safety
          </span>
        )}
      </div>

      <p className="text-xs break-words" style={{ color: 'var(--text-muted)' }}>
        {hasVerifiedCourse ? (
          <>
            Course data: {course.provenance} from{' '}
            {course.url ? <a href={course.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{course.source || course.url}</a> : (course.source || 'verified source')}.
          </>
        ) : 'Course data: no verified course data; this calendar uses the race date and distance only.'}
      </p>

      {adaptationError && (
        <p className="text-sm rounded-lg p-3 break-words" style={{ background: 'var(--danger-dim)', color: 'var(--danger)' }}>{adaptationError}</p>
      )}
      {adaptationDecision === 'accepted' && (
        <p className="text-sm rounded-lg p-3" style={{ background: 'rgba(22, 163, 74, 0.12)', color: 'var(--success)' }}>Accepted. Calendar updated.</p>
      )}
      {adaptationDecision === 'kept' && (
        <p className="text-sm rounded-lg p-3" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>Kept original calendar.</p>
      )}

      {!adaptationLoading && adaptationProposal && (
        <>
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)' }}>Evidence</p>
            {(adaptationProposal.evidence || []).length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No fresh driver was strong enough to change the calendar.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {(adaptationProposal.evidence || []).map((item, index) => (
                  <div key={`${item.signal || 'signal'}-${index}`} className="rounded-lg p-3 min-w-0" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{formatEvidenceSource(item.source)}</span>
                      <span className="text-[11px] rounded-full px-2 py-0.5" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>{item.objective ? 'objective' : 'subjective'}</span>
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{item.freshness}</span>
                    </div>
                    <p className="text-sm mt-1 break-words" style={{ color: 'var(--text-muted)' }}>{item.detail}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)' }}>Changed sessions</p>
            {(adaptationProposal.changes || []).length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No sessions change.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {(adaptationProposal.changes || []).map((change) => (
                  <div key={`${change.date}-${change.sessionId}`} className="rounded-lg p-3 min-w-0" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>{change.date}</p>
                    <p className="text-sm mt-1 break-words" style={{ color: 'var(--text-primary)' }}>{formatSession(change.before)} → {formatSession(change.after)}</p>
                    <p className="text-xs mt-1 break-words" style={{ color: 'var(--text-muted)' }}>{change.summary}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {hasAdaptationChanges && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button type="button" onClick={() => decideAdaptation('accept')} disabled={Boolean(decidingAdaptation)}
                className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
                {decidingAdaptation === 'accept' ? 'Accepting...' : 'Accept'}
              </button>
              <button type="button" onClick={() => decideAdaptation('keep')} disabled={Boolean(decidingAdaptation)}
                className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60"
                style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
                {decidingAdaptation === 'keep' ? 'Saving...' : 'Keep original'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  ) : null

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
              onStartRun={(runSession) => navigate('/warmup', { state: {
                planSessionId: runSession?.id != null ? String(runSession.id) : null,
                currentWeek: Number.isFinite(selectedDay?.weekIndex) ? selectedDay.weekIndex + 1 : currentWeek,
                scheduledRun: runSession || null,
              } })}
              onStartLift={(liftSession) => navigate('/log-lift', { state: {
                planSessionId: liftSession?.id != null ? String(liftSession.id) : null,
                currentWeek: Number.isFinite(selectedDay?.weekIndex) ? selectedDay.weekIndex + 1 : currentWeek,
                scheduledLift: liftSession || null,
              } })}
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

              {adaptationPanel}

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
                    {!isActiveSchemaV2 && adaptivePanel}
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
