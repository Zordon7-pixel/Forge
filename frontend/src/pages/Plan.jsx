import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Circle } from 'lucide-react'
import api from '../lib/api'

function sessionLabel(session = {}) {
  if (session.type === 'run') {
    const miles = Number(session.distance_miles || 0)
    if (miles > 0) return `${session.title || 'Run'} · ${miles.toFixed(1)} mi`
  }
  return session.title || String(session.type || 'session').replace('_', ' ')
}

export default function Plan() {
  const [plans, setPlans] = useState([])
  const [myPlan, setMyPlan] = useState(null)
  const [myUserPlan, setMyUserPlan] = useState(null)
  const [adaptivePlan, setAdaptivePlan] = useState(null)
  const [adaptiveLoading, setAdaptiveLoading] = useState(false)
  const [acceptingAdaptive, setAcceptingAdaptive] = useState(false)
  const [loading, setLoading] = useState(true)
  const [assigningId, setAssigningId] = useState(null)
  const [updating, setUpdating] = useState(false)

  const loadAll = async () => {
    setLoading(true)
    setAdaptiveLoading(true)
    try {
      const [plansRes, myRes, adaptiveRes] = await Promise.all([
        api.get('/plans'),
        api.get('/plans/my'),
        api.get('/plans/adaptive/recommend').catch(() => ({ data: null })),
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
  }, [])

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
  const weekData = useMemo(() => {
    const weeks = myPlan?.plan_data?.weeks || []
    return weeks[currentWeek - 1] || weeks[0] || null
  }, [myPlan, currentWeek])
  const completedSet = new Set(myUserPlan?.progress?.completedSessionIds || [])
  const totalInWeek = (weekData?.sessions || []).filter((s) => s.type !== 'rest').length
  const completedInWeek = (weekData?.sessions || []).filter((s) => s.type !== 'rest' && completedSet.has(String(s.id))).length
  const weekProgress = totalInWeek > 0 ? Math.round((completedInWeek / totalInWeek) * 100) : 0

  const toggleSession = async (sessionId) => {
    const isCompleted = completedSet.has(String(sessionId))
    setUpdating(true)
    try {
      await api.put('/plans/my/progress', isCompleted
        ? { unset_session_id: sessionId, current_week: currentWeek }
        : { completed_session_id: sessionId, current_week: currentWeek }
      )
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
      await api.post('/plans/adaptive/accept')
      await loadAll()
    } finally {
      setAcceptingAdaptive(false)
    }
  }

  const intensityMeta = useMemo(() => {
    const key = String(adaptivePlan?.intensity || 'normal').toLowerCase()
    if (key === 'recovery') return { label: '🔴 Recovery', color: '#EF4444' }
    if (key === 'reduced') return { label: '🟡 Reduced', color: '#EAB308' }
    if (key === 'increased') return { label: '💪 Increased', color: '#22C55E' }
    return { label: '🟢 Normal', color: '#16A34A' }
  }, [adaptivePlan?.intensity])

  if (loading) {
    return <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>Loading training plans...</div>
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Adaptive Plan</h2>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>This week&apos;s recommended plan based on your check-ins.</p>
          </div>
          <span className="text-xs font-bold rounded-full px-3 py-1" style={{ background: 'var(--bg-input)', color: intensityMeta.color }}>
            {intensityMeta.label}
          </span>
        </div>

        {adaptiveLoading && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading adaptive recommendation...</p>}
        {!adaptiveLoading && !adaptivePlan && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Adaptive recommendation is not available yet.</p>}
        {!adaptiveLoading && adaptivePlan && (
          <>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{adaptivePlan.reason || adaptivePlan.recommendation}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(adaptivePlan.sessions || []).map((session) => (
                <div
                  key={session.id}
                  className="rounded-lg p-3"
                  style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
                >
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
            <button
              onClick={acceptAdaptive}
              disabled={acceptingAdaptive}
              className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60"
              style={{ background: 'var(--accent)', color: '#000' }}
            >
              {acceptingAdaptive ? 'Saving...' : 'Accept Plan'}
            </button>
          </>
        )}
      </div>

      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Training Plans</h2>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Running-first plans. Strength sessions focus on injury prevention only.</p>
      </div>

      {!myPlan && (
        <div className="grid gap-3">
          {plans.map((plan) => (
            <div key={plan.id} className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
              <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{plan.name}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{plan.type} · {plan.weeks} weeks</p>
              <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>{plan.description}</p>
              <button
                onClick={() => assignPlan(plan.id)}
                disabled={assigningId === plan.id}
                className="mt-3 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60"
                style={{ background: 'var(--accent)', color: '#000' }}
              >
                {assigningId === plan.id ? 'Assigning...' : 'Assign Plan'}
              </button>
            </div>
          ))}
        </div>
      )}

      {myPlan && (
        <div className="space-y-3">
          <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{myPlan.name}</p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {myPlan.type} · Week {currentWeek} of {myPlan.weeks}
            </p>
            <div className="mt-3 h-2 rounded-full" style={{ background: 'var(--bg-input)' }}>
              <div className="h-2 rounded-full" style={{ width: `${weekProgress}%`, background: '#EAB308' }} />
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{weekProgress}% complete this week</p>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => goToWeek(Math.max(1, currentWeek - 1))}
              disabled={currentWeek <= 1 || updating}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}
            >
              Previous Week
            </button>
            <button
              onClick={() => goToWeek(Math.min(Number(myPlan.weeks || currentWeek), currentWeek + 1))}
              disabled={currentWeek >= Number(myPlan.weeks || currentWeek) || updating}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}
            >
              Next Week
            </button>
          </div>

          <div className="rounded-xl p-4 space-y-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            {(weekData?.sessions || []).map((session) => {
              const isDone = completedSet.has(String(session.id))
              return (
                <button
                  key={session.id}
                  onClick={() => session.type !== 'rest' && toggleSession(session.id)}
                  disabled={updating || session.type === 'rest'}
                  className="w-full rounded-lg p-3 flex items-center justify-between disabled:opacity-70"
                  style={{ background: 'var(--bg-input)' }}
                >
                  <div className="text-left">
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{session.day}</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{sessionLabel(session)}</p>
                  </div>
                  {session.type === 'rest'
                    ? <p className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>REST</p>
                    : isDone
                      ? <CheckCircle2 size={18} color="#EAB308" />
                      : <Circle size={18} color="var(--text-muted)" />}
                </button>
              )
            })}
          </div>

          <button
            onClick={() => {
              setMyPlan(null)
              setMyUserPlan(null)
            }}
            className="rounded-lg px-4 py-2 text-sm font-semibold"
            style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}
          >
            Change Plan
          </button>
        </div>
      )}
    </div>
  )
}
