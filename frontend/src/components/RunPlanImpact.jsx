import { useEffect, useState } from 'react'
import { CalendarCheck2 } from 'lucide-react'
import api from '../lib/api'
import { todayISO } from '../lib/planCalendar'

function changeLabel(change) {
  const before = change?.before?.title || change?.before?.name || change?.before?.type || 'Planned session'
  const after = change?.after?.title || change?.after?.name || change?.after?.type || 'Adjusted session'
  return `${before} -> ${after}`
}

export default function RunPlanImpact({ run }) {
  const [proposal, setProposal] = useState(null)
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [decision, setDecision] = useState('')
  const [deciding, setDeciding] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setDecision('')
    api.get('/plans/adaptation/current', { params: { date: todayISO() } })
      .then((response) => {
        if (!active) return
        setProposal(response.data?.proposal || null)
        setReason(response.data?.reason || '')
      })
      .catch((requestError) => {
        if (!active) return
        console.error('[RunPlanImpact] analysis failed:', requestError?.message || requestError)
        setProposal(null)
        setReason('')
        setError(requestError?.response?.data?.error || 'Plan impact is unavailable right now.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [run?.id, run?.perceived_effort, run?.pain_level, run?.post_energy])

  const decide = async (nextDecision) => {
    if (!proposal?.id || deciding) return
    setDeciding(nextDecision)
    setError('')
    try {
      const response = await api.post(`/plans/adaptation/${proposal.id}/${nextDecision}`)
      setDecision(response.data?.status || (nextDecision === 'accept' ? 'accepted' : 'kept'))
      setProposal(null)
    } catch (requestError) {
      console.error(`[RunPlanImpact] ${nextDecision} failed:`, requestError?.message || requestError)
      setError(requestError?.response?.data?.error || 'The plan decision could not be saved.')
    } finally {
      setDeciding('')
    }
  }

  const changes = Array.isArray(proposal?.changes) ? proposal.changes : []
  const hasChanges = proposal?.status === 'proposal' && changes.length > 0
  const statusTitle = decision === 'accepted'
    ? 'Plan adjusted'
    : decision === 'kept'
      ? 'Original plan kept'
      : hasChanges
        ? proposal.headline || 'Plan adjustment available'
        : 'Plan stays as written'

  return (
    <section className="mb-5 rounded-xl p-4" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }} aria-label="Run plan impact">
      <div className="flex items-start gap-2">
        <CalendarCheck2 size={17} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.6 }}>Plan impact</p>
          <p className="mt-1 text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
            {loading ? 'Analyzing this run...' : statusTitle}
          </p>
          {!loading && !error && !decision && (
            <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {hasChanges
                ? proposal.reason
                : reason || 'This run is included in your current training load. No calendar change is recommended.'}
            </p>
          )}
          {decision === 'accepted' && <p className="mt-1 text-xs" style={{ color: 'var(--success)' }}>The proposed change is now on your calendar.</p>}
          {decision === 'kept' && <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>This run still counts toward future analysis; today&apos;s calendar remains unchanged.</p>}
          {error && <p role="alert" className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>{error}</p>}
        </div>
      </div>

      {hasChanges && !decision && (
        <>
          <div className="mt-3 space-y-2">
            {changes.slice(0, 3).map((change, index) => (
              <div key={`${change.date || 'date'}-${change.sessionId || index}`} className="rounded-lg p-3" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
                <p className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>{change.date || 'Upcoming session'}</p>
                <p className="mt-1 text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{changeLabel(change)}</p>
                {change.summary && <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{change.summary}</p>}
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => decide('accept')} disabled={Boolean(deciding)} className="pressable min-h-11 rounded-lg px-3 text-sm font-bold disabled:opacity-60" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
              {deciding === 'accept' ? 'Applying...' : 'Apply adjustment'}
            </button>
            <button type="button" onClick={() => decide('keep')} disabled={Boolean(deciding)} className="pressable min-h-11 rounded-lg px-3 text-sm font-bold disabled:opacity-60" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
              {deciding === 'keep' ? 'Saving...' : 'Keep plan'}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
