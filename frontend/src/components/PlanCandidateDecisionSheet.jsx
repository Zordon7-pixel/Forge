import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, ShieldCheck, X } from 'lucide-react'
import { useNavigate } from 'react-router'
import { activateModalDialog } from '../lib/modalDialog'
import {
  registerPlanCandidateReviewer,
} from '../lib/planCandidateReview'

function candidatePlan(preview = {}) {
  return preview?.plan?.plan_data || preview?.candidate?.plan_data || {}
}

function decisionCopy(feasibility) {
  if (feasibility === 'unsafe') {
    return {
      eyebrow: 'Target needs review',
      title: 'Keep your current plan',
      summary: 'The requested target does not pass the current safety checks. Review the race goal before replacing your calendar.',
    }
  }
  if (feasibility === 'stretch') {
    return {
      eyebrow: 'Stretch target',
      title: 'Review this plan change',
      summary: 'This target needs a successful checkpoint. Apply it only if you want to train toward the target while Forged Hybrid keeps evaluating the evidence.',
    }
  }
  return {
    eyebrow: 'Calendar change',
    title: 'Replace your current plan?',
    summary: 'Your existing calendar stays active unless you approve this reviewed replacement.',
  }
}

function displayDate(value) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
    ? new Date(`${value}T12:00:00`)
    : null
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null
}

export default function PlanCandidateDecisionSheet() {
  const navigate = useNavigate()
  const dialogRef = useRef(null)
  const resolverRef = useRef(null)
  const [preview, setPreview] = useState(null)

  const settle = useCallback((decision) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setPreview(null)
    resolve?.(decision)
  }, [])

  useEffect(() => registerPlanCandidateReviewer((nextPreview) => {
    if (resolverRef.current) {
      const error = new Error('Another plan review is already open.')
      error.code = 'PLAN_REVIEW_IN_PROGRESS'
      return Promise.reject(error)
    }
    return new Promise((resolve) => {
      resolverRef.current = resolve
      setPreview(nextPreview)
    })
  }), [])

  useEffect(() => () => {
    resolverRef.current?.('cancel')
    resolverRef.current = null
  }, [])

  useEffect(() => {
    if (!preview) return undefined
    return activateModalDialog({
      dialog: dialogRef.current,
      onClose: () => settle('cancel'),
    })
  }, [preview, settle])

  const plan = useMemo(() => candidatePlan(preview), [preview])
  const feasibility = String(plan?.overall_feasibility || '').toLowerCase()
  const copy = decisionCopy(feasibility)
  const reasons = Array.isArray(plan?.reasons) ? plan.reasons.slice(0, 3) : []
  const canApply = feasibility === 'supported' || feasibility === 'stretch'
  const effectiveDate = displayDate(preview?.effective_from || preview?.candidate?.effective_from)

  if (!preview) return null

  const reviewGoal = () => {
    settle('review_goal')
    navigate('/races')
  }

  return (
    <div
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) settle('cancel') }}
      style={{ position: 'fixed', inset: 0, zIndex: 150, display: 'grid', alignItems: 'end', justifyItems: 'center', background: 'rgba(0,0,0,0.82)', padding: '12px 12px calc(12px + env(safe-area-inset-bottom, 0px))' }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-candidate-review-title"
        className="w-full max-w-[480px] rounded-2xl p-5"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', maxHeight: 'min(84dvh, 720px)', overflowY: 'auto', boxSizing: 'border-box' }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-black uppercase" style={{ color: feasibility === 'unsafe' ? 'var(--danger)' : 'var(--accent)', letterSpacing: 0.8 }}>{copy.eyebrow}</p>
            <h2 id="plan-candidate-review-title" className="mt-2 text-2xl font-black leading-tight" style={{ color: 'var(--text-primary)' }}>{copy.title}</h2>
          </div>
          <button type="button" onClick={() => settle('cancel')} aria-label="Keep current plan" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>
            <X size={20} />
          </button>
        </div>

        <div className="mt-4 flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: feasibility === 'unsafe' ? 'var(--danger-dim)' : 'var(--accent-dim)', color: feasibility === 'unsafe' ? 'var(--danger)' : 'var(--accent)' }}>
          {feasibility === 'unsafe' ? <AlertTriangle size={22} /> : <ShieldCheck size={22} />}
        </div>
        <p className="mt-3 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>{copy.summary}</p>
        {effectiveDate && (
          <p className="mt-2 text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
            {preview?.replaces_active_plan ? `Your current plan stays in place today. This plan starts ${effectiveDate}.` : `This plan starts ${effectiveDate}.`}
          </p>
        )}

        {reasons.length > 0 && (
          <div className="mt-4 rounded-xl p-4" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-xs font-black uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>What Forged checked</p>
            <ul className="mt-3 space-y-2">
              {reasons.map((reason) => (
                <li key={reason} className="flex gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                  <Check size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
                  <span>{String(reason).replaceAll('_', ' ')}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 grid gap-2">
          {canApply && (
            <button type="button" onClick={() => settle('apply')} className="min-h-12 rounded-xl px-4 py-3 text-sm font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none' }}>
              {feasibility === 'stretch' ? 'Keep target and apply' : 'Apply reviewed plan'}
            </button>
          )}
          <button type="button" onClick={reviewGoal} className="min-h-12 rounded-xl px-4 py-3 text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>Review race target</button>
          <button type="button" onClick={() => settle('cancel')} className="min-h-11 bg-transparent px-4 py-2 text-sm font-bold" style={{ color: 'var(--text-muted)', border: 'none' }}>Keep current plan</button>
        </div>
      </section>
    </div>
  )
}
