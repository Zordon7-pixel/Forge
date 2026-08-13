import { useEffect, useRef, useState } from 'react'
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
  const requestTokenRef = useRef(0)
  const proposalIdRef = useRef(null)

  useEffect(() => {
    const requestToken = requestTokenRef.current + 1
    requestTokenRef.current = requestToken
    setLoading(true)
    setError('')
    setDecision('')
    setDeciding('')
    setProposal(null)
    proposalIdRef.current = null
    setReason('')
    if (!run?.id) {
      setLoading(false)
      return () => { requestTokenRef.current += 1 }
    }
    api.get(`/plans/adaptation/run/${encodeURIComponent(run.id)}`, { params: { date: todayISO() } })
      .then((response) => {
        if (requestTokenRef.current !== requestToken) return
        const nextProposal = response.data?.impact || null
        proposalIdRef.current = nextProposal?.id || null
        setProposal(nextProposal)
        setReason(response.data?.reason || '')
      })
      .catch((requestError) => {
        if (requestTokenRef.current !== requestToken) return
        console.error('[RunPlanImpact] analysis failed:', requestError?.message || requestError)
        setProposal(null)
        setReason('')
        setError(requestError?.response?.data?.error || 'Plan impact is unavailable right now.')
      })
      .finally(() => {
        if (requestTokenRef.current === requestToken) setLoading(false)
      })
    return () => {
      if (requestTokenRef.current === requestToken) requestTokenRef.current += 1
    }
  }, [run?.id, run?.perceived_effort, run?.pain_level, run?.post_energy])

  const decide = async (nextDecision) => {
    if (!proposal?.id || deciding) return
    const requestToken = requestTokenRef.current
    const proposalId = proposal.id
    setDeciding(nextDecision)
    setError('')
    try {
      const response = await api.post(`/plans/adaptation/${proposalId}/${nextDecision}`, {
        proposal_revision: proposal.revision,
        proposal_plan_version: proposal.planVersion,
      })
      if (requestTokenRef.current !== requestToken || proposalIdRef.current !== proposalId) return
      setDecision(response.data?.status || (nextDecision === 'accept' ? 'accepted' : 'kept'))
      const nextProposal = response.data?.proposal || proposal
      proposalIdRef.current = nextProposal?.id || null
      setProposal(nextProposal)
    } catch (requestError) {
      if (requestTokenRef.current !== requestToken) return
      console.error(`[RunPlanImpact] ${nextDecision} failed:`, requestError?.message || requestError)
      setError(requestError?.response?.data?.error || 'The plan decision could not be saved.')
    } finally {
      if (requestTokenRef.current === requestToken && proposalIdRef.current === proposalId) setDeciding('')
    }
  }

  const changes = Array.isArray(proposal?.changes) ? proposal.changes : []
  const effectiveDecision = decision || proposal?.decisionStatus || ''
  const hasChanges = proposal?.status === 'proposal' && proposal?.decisionStatus === 'pending' && changes.length > 0
  const statusTitle = effectiveDecision === 'accepted'
    ? 'Plan adjusted'
    : effectiveDecision === 'kept'
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
          {!loading && !error && !['accepted', 'kept'].includes(effectiveDecision) && (
            <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {hasChanges
                ? proposal.reason
                : reason || 'This run is included in your current training load. No calendar change is recommended.'}
            </p>
          )}
          {effectiveDecision === 'accepted' && <p className="mt-1 text-xs" style={{ color: 'var(--success)' }}>The proposed change is now on your calendar.</p>}
          {effectiveDecision === 'kept' && <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>This run still counts toward future analysis; today&apos;s calendar remains unchanged.</p>}
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
