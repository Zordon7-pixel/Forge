import React from 'react'
import { CalendarClock, ChevronRight } from 'lucide-react'

const IDENTITY_LABELS = {
  run: 'Run',
  lift: 'Lift',
  hybrid: 'Run + lift',
  rest: 'Rest',
}

function metricLabel(metric) {
  return metric.unit ? `${metric.value} ${metric.unit}` : String(metric.value)
}

export default function TomorrowPlanCard({ plan, onOpenPlan }) {
  if (!plan) return null
  return (
    <section
      aria-labelledby="tomorrow-plan-title"
      className="card-hero p-5"
      style={{ minWidth: 0, overflow: 'hidden' }}
    >
      <div className="flex min-w-0 items-start gap-3">
        <CalendarClock size={20} aria-hidden="true" style={{ flex: '0 0 auto', color: 'var(--accent)', marginTop: 2 }} />
        <div className="min-w-0 flex-1" style={{ overflowWrap: 'anywhere' }}>
          <p className="t-micro" style={{ color: 'var(--accent)', margin: 0 }}>Tomorrow</p>
          <p className="mt-1 text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>{plan.dateLabel}</p>

          {plan.status === 'training' ? (
            <>
              {plan.identity && <p className="mt-3 text-xs font-black uppercase" style={{ color: 'var(--text-muted)' }}>{IDENTITY_LABELS[plan.identity]}</p>}
              <div className="mt-2 space-y-3">
                {plan.sessions.map((session, index) => (
                  <div key={session.id || `${session.kind || 'session'}-${index}`} className="min-w-0">
                    {session.title && <h2 id={index === 0 ? 'tomorrow-plan-title' : undefined} className="text-lg font-black" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{session.title}</h2>}
                    {session.metrics.length > 0 && (
                      <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
                        {session.metrics.map(metricLabel).join(' · ')}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <h2 id="tomorrow-plan-title" className="mt-2 text-lg font-black" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{plan.title}</h2>
          )}

          {(plan.phase || plan.reason) && (
            <p className="mt-3 text-sm leading-6" style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
              {[plan.phase, plan.reason].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={onOpenPlan}
        className="pressable mt-4 flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm font-black"
        style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none' }}
      >
        <span className="min-w-0" style={{ overflowWrap: 'anywhere' }}>Open tomorrow in Plan</span>
        <ChevronRight size={17} aria-hidden="true" style={{ flex: '0 0 auto' }} />
      </button>
    </section>
  )
}
