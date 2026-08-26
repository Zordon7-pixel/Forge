import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import api from '../lib/api'
import LoadingRunner from '../components/LoadingRunner'
import RunDetailModal from '../components/RunDetailModal'
import RunMediaManager from '../components/RunMediaManager'
import ForgedStrike from '../components/ForgedStrike'
import { getAuthenticatedUserId } from '../lib/auth'
import { clearPostRunCheckInDraft } from '../lib/postRunCheckInDraft'
import {
  clearRunCompletionHandoff,
  loadRunCompletionHandoff,
  RUN_COMPLETION_HANDOFF_EVENT,
  RUN_COMPLETION_PHASE,
  RUN_RECAP_TABS,
  updateRunCompletionHandoff,
} from '../lib/runCompletionHandoff'

/*
 * Phase B migration note: PostRunCheckIn formerly owned a separate
 * data-testid="post-run-checkin-viewport" with presentation="page" here.
 * The recap now ignores that retired handoff state and renders factual data directly.
 */

export default function RunRecap() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [ownerUserId] = useState(() => getAuthenticatedUserId())
  const [handoff, setHandoff] = useState(() => loadRunCompletionHandoff(id, ownerUserId))
  const [run, setRun] = useState(() => handoff?.snapshot || null)
  const [hrZones, setHrZones] = useState([])
  const [hrProfile, setHrProfile] = useState(null)
  const [loading, setLoading] = useState(() => !handoff?.snapshot)
  const [error, setError] = useState('')
  const [retryVersion, setRetryVersion] = useState(0)
  const [activeTab, setActiveTab] = useState('summary')
  const [showStrike, setShowStrike] = useState(true)

  useEffect(() => {
    clearPostRunCheckInDraft()
    const restoredHandoff = loadRunCompletionHandoff(id, ownerUserId)
    if (!restoredHandoff) return
    const refreshed = updateRunCompletionHandoff(id, ownerUserId, {
      checkInPending: false,
      phase: restoredHandoff.queued ? RUN_COMPLETION_PHASE.QUEUED : RUN_COMPLETION_PHASE.RECAP_READY,
    })
    if (refreshed) setHandoff(refreshed)
  }, [id, ownerUserId])

  useEffect(() => {
    const refreshHandoff = () => {
      const refreshed = loadRunCompletionHandoff(id, ownerUserId)
      setHandoff(refreshed)
    }
    window.addEventListener(RUN_COMPLETION_HANDOFF_EVENT, refreshHandoff)
    return () => window.removeEventListener(RUN_COMPLETION_HANDOFF_EVENT, refreshHandoff)
  }, [id, ownerUserId])

  useEffect(() => {
    let active = true
    setLoading(!run)
    setError('')
    Promise.all([
      api.get(`/runs/${encodeURIComponent(id)}`),
      api.get('/profile/hr-zones').catch((requestError) => {
        console.error('[RunRecap] heart-rate profile unavailable:', requestError?.message || requestError)
        return { data: { zones: [], profile: null } }
      }),
    ])
      .then(([runResponse, zonesResponse]) => {
        if (!active) return
        const savedRun = runResponse.data?.run || null
        if (!savedRun) throw new Error('Run recap response did not include a run.')
        setRun(savedRun)
        setHrZones(Array.isArray(zonesResponse.data?.zones) ? zonesResponse.data.zones : [])
        setHrProfile(zonesResponse.data?.profile || null)
        const refreshed = updateRunCompletionHandoff(id, ownerUserId, {
          queued: false,
          checkInPending: false,
          phase: RUN_COMPLETION_PHASE.RECAP_READY,
          snapshot: savedRun,
        })
        if (refreshed) setHandoff(refreshed)
      })
      .catch((requestError) => {
        console.error('[RunRecap] load failed:', requestError?.message || requestError)
        if (!active) return
        const fallback = handoff?.snapshot || run
        if (fallback) setRun(fallback)
        setError(fallback
          ? 'Showing the recap saved on this device. Some synced details may still be unavailable.'
          : requestError?.response?.data?.error || 'Could not load this run recap.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => { active = false }
  // `retryVersion` is the explicit retry trigger; retaining the first fallback avoids fetch loops.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ownerUserId, retryVersion])

  const finishHandoff = useCallback(() => {
    clearRunCompletionHandoff(id, ownerUserId)
    setHandoff(null)
  }, [id, ownerUserId])

  const leaveRecap = useCallback((destination) => {
    finishHandoff()
    navigate(destination, { replace: true })
  }, [finishHandoff, navigate])

  const moveTabFocus = (event, currentIndex) => {
    let nextIndex = null
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % RUN_RECAP_TABS.length
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + RUN_RECAP_TABS.length) % RUN_RECAP_TABS.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = RUN_RECAP_TABS.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const nextTab = RUN_RECAP_TABS[nextIndex]
    setActiveTab(nextTab.key)
    window.requestAnimationFrame(() => document.getElementById(`run-recap-tab-${nextTab.key}`)?.focus())
  }

  if (loading && !run) {
    return (
      <div className="fixed inset-0 z-40 grid place-items-center" style={{ background: 'var(--bg-base)' }}>
        <LoadingRunner message="Loading run recap" />
      </div>
    )
  }

  if (!run) {
    return (
      <div className="fixed inset-0 z-40 overflow-y-auto px-5 text-center" style={{ background: 'var(--bg-base)', paddingTop: 'calc(env(safe-area-inset-top, 0px) + 4rem)' }}>
        <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Run recap unavailable</h1>
        <p className="mt-2 text-sm" role="alert" style={{ color: 'var(--text-muted)' }}>{error}</p>
        <div className="mx-auto mt-5 grid max-w-sm grid-cols-2 gap-3">
          <button type="button" onClick={() => setRetryVersion((value) => value + 1)} className="rounded-xl px-4 py-3 text-sm font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>Retry</button>
          <button type="button" onClick={() => leaveRecap('/history')} className="rounded-xl border px-4 py-3 text-sm font-semibold" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}>Open history</button>
        </div>
      </div>
    )
  }

  const queued = Boolean(handoff?.queued)

  return (
    <div
      className="fixed inset-0 z-40 overflow-y-auto overscroll-contain"
      data-testid="run-recap-viewport"
      style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
    >
      <div
        className="mx-auto min-h-full w-full max-w-2xl px-3 sm:px-4"
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.25rem)' }}
      >
        {showStrike && !queued && (
          <ForgedStrike
            subline={run.name || run.title || 'Run Complete'}
            onDone={() => setShowStrike(false)}
          />
        )}

        {(queued || error || handoff?.planProgressNotice || handoff?.heatDrift?.drifted) && (
          <div className="mb-3 space-y-2" aria-live="polite">
            {queued && <p className="rounded-xl p-3 text-sm font-semibold" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)', color: 'var(--accent)' }}>Saved offline. This factual device recap remains available while the run waits to sync.</p>}
            {handoff?.planProgressNotice && <p className="rounded-xl p-3 text-sm" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>{handoff.planProgressNotice}</p>}
            {handoff?.heatDrift?.drifted && (
              <section className="rounded-xl p-3 text-sm" aria-label="Heat drift" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                <p className="font-bold" style={{ color: 'var(--accent)' }}>{handoff.heatDrift.label || 'Heat drift detected'}</p>
                {handoff.heatDrift.reason && <p className="mt-1" style={{ color: 'var(--text-muted)' }}>{handoff.heatDrift.reason}</p>}
              </section>
            )}
            {error && (
              <div className="rounded-xl p-3 text-sm" role="status" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                <p>{error}</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={() => setRetryVersion((value) => value + 1)} className="rounded-lg px-3 py-2 text-xs font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>Retry synced recap</button>
                  <button type="button" onClick={() => leaveRecap('/history')} className="rounded-lg border px-3 py-2 text-xs font-semibold" style={{ borderColor: 'var(--border-subtle)' }}>History</button>
                </div>
              </div>
            )}
          </div>
        )}

        <div
          role="tablist"
          aria-label="Run recap sections"
          className="mb-4 flex snap-x gap-2 overflow-x-auto pb-2"
          data-testid="run-recap-tabs"
        >
          {RUN_RECAP_TABS.map((tab, tabIndex) => {
            const selected = activeTab === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                id={`run-recap-tab-${tab.key}`}
                aria-controls={`run-recap-panel-${tab.key}`}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveTab(tab.key)}
                onKeyDown={(event) => moveTabFocus(event, tabIndex)}
                className="min-h-11 shrink-0 snap-start rounded-xl px-3 py-2 text-xs font-bold"
                style={{
                  background: selected ? 'var(--accent)' : 'var(--bg-card)',
                  color: selected ? 'var(--on-accent)' : 'var(--text-primary)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                {tab.label}
              </button>
            )
          })}
        </div>

        <section
          role="tabpanel"
          id={`run-recap-panel-${activeTab}`}
          aria-labelledby={`run-recap-tab-${activeTab}`}
          tabIndex={0}
          className="outline-none focus-visible:ring-2"
          style={{ '--tw-ring-color': 'var(--accent)' }}
        >
          <RunDetailModal
            standalone
            activePanel={activeTab}
            run={run}
            hrZones={hrZones}
            hrProfile={hrProfile}
            onClose={() => leaveRecap('/history')}
            onFeedbackGenerated={(runId, feedback) => {
              if (runId === run.id) setRun((current) => ({ ...current, ai_feedback: feedback }))
            }}
          />

          {activeTab === 'media' && (
            queued
              ? <p className="mb-5 rounded-xl border p-4 text-sm" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-muted)' }}>Private run-photo storage becomes available after this queued run syncs. Share can still use the factual recap above.</p>
              : <RunMediaManager runId={run.id} />
          )}
        </section>

        <div className="grid grid-cols-3 gap-2 pb-2">
          <button type="button" onClick={() => leaveRecap('/history')} className="min-h-12 rounded-xl border px-2 py-3 text-xs font-semibold" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }}>History</button>
          <button type="button" onClick={() => leaveRecap('/stretches/session?type=post')} className="min-h-12 rounded-xl px-2 py-3 text-xs font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>Recovery</button>
          <button type="button" onClick={() => leaveRecap('/')} className="min-h-12 rounded-xl border px-2 py-3 text-xs font-semibold" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }}>Done</button>
        </div>
      </div>

    </div>
  )
}
