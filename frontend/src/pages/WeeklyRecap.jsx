import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import { Activity, AlertTriangle, Brain, Dumbbell, Flame, Gauge, Ruler, Timer, Trophy, X } from 'lucide-react'
import api from '../lib/api'
import LoadingRunner from '../components/LoadingRunner'
import { useProContext } from '../context/ProContext'
import ProGate from '../components/ProGate'
import AiGuidanceNote from '../components/AiGuidanceNote'
import useDialogFocus from '../lib/useDialogFocus'
import { buildWeeklyRecapView } from '../lib/dashboardBrief'

const METRIC_ICONS = {
  distance: Ruler,
  runs: Activity,
  duration: Timer,
  consistency: Flame,
  calories: Gauge,
  pace: Timer,
  strength: Dumbbell,
}

function StatCard({ metric }) {
  const Icon = METRIC_ICONS[metric.key] || Activity
  return (
    <div className="weekly-recap-stat" data-recap-metric={metric.key}>
      <div>
        <Icon size={16} aria-hidden="true" />
        <dt>{metric.label}</dt>
      </div>
      <dd>{metric.value}</dd>
    </div>
  )
}

export function WeeklyRecapPresenter({ data, modal = false }) {
  const view = buildWeeklyRecapView(data)
  if (!view) {
    return <p className="weekly-recap-empty">No completed-week recap is available yet.</p>
  }

  const Heading = modal ? 'h3' : 'h1'
  const DetailHeading = modal ? 'h4' : 'h2'
  const mileageDelta = view.mileageDelta
  const deltaLabel = mileageDelta === null
    ? ''
    : `${mileageDelta > 0 ? '+' : ''}${mileageDelta}% vs last week`

  return (
    <div className="weekly-recap-presenter" data-weekly-recap-presenter>
      <section className="card-hero weekly-recap-overview" aria-labelledby={modal ? 'weekly-recap-period-modal' : 'weekly-recap-period-page'}>
        <p className="weekly-recap-eyebrow">Completed week</p>
        <Heading id={modal ? 'weekly-recap-period-modal' : 'weekly-recap-period-page'}>{view.weekLabel}</Heading>
        {deltaLabel && <p className="weekly-recap-delta">{deltaLabel}</p>}
      </section>

      {view.metrics.length > 0 && (
        <dl className="weekly-recap-stats" aria-label="Weekly recap metrics">
          {view.metrics.map((metric) => <StatCard key={metric.key} metric={metric} />)}
        </dl>
      )}

      {view.highlight && (
        <section className="weekly-recap-detail" aria-labelledby={modal ? 'weekly-highlight-modal' : 'weekly-highlight-page'}>
          <div className="weekly-recap-detail-heading">
            <Trophy size={17} aria-hidden="true" />
            <DetailHeading id={modal ? 'weekly-highlight-modal' : 'weekly-highlight-page'}>Highlight</DetailHeading>
          </div>
          <p><strong>{view.highlight.label}</strong> — {view.highlight.text}</p>
        </section>
      )}

      {view.riskReason && (
        <section className="weekly-recap-detail weekly-recap-risk" aria-labelledby={modal ? 'weekly-risk-modal' : 'weekly-risk-page'}>
          <div className="weekly-recap-detail-heading">
            <AlertTriangle size={17} aria-hidden="true" />
            <DetailHeading id={modal ? 'weekly-risk-modal' : 'weekly-risk-page'}>Load watch</DetailHeading>
          </div>
          <p>{view.riskReason}</p>
        </section>
      )}

      {view.nextWeek && (
        <section className="weekly-recap-detail weekly-recap-next" aria-labelledby={modal ? 'weekly-next-modal' : 'weekly-next-page'}>
          <div className="weekly-recap-detail-heading">
            <Brain size={17} aria-hidden="true" />
            <DetailHeading id={modal ? 'weekly-next-modal' : 'weekly-next-page'}>Next week</DetailHeading>
          </div>
          <p>{view.nextWeek}</p>
          {data?.is_pro && <AiGuidanceNote />}
        </section>
      )}
    </div>
  )
}

export function WeeklyRecapDialog({ open, data, onClose }) {
  const active = Boolean(open && data)
  const dialogRef = useDialogFocus(active, onClose)

  useEffect(() => {
    if (!active) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [active])

  if (!active) return null

  return createPortal(
    <div className="weekly-recap-backdrop" data-weekly-recap-overlay onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="weekly-recap-dialog-title"
        tabIndex={-1}
        className="weekly-recap-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="weekly-recap-dialog-header">
          <div>
            <p>Training review</p>
            <h2 id="weekly-recap-dialog-title">Weekly recap</h2>
          </div>
          <button type="button" aria-label="Close weekly recap" onClick={onClose}>
            <X size={19} aria-hidden="true" />
          </button>
        </header>
        <div className="weekly-recap-dialog-scrollport" data-weekly-recap-scrollport>
          <WeeklyRecapPresenter data={data} modal />
          <button type="button" className="weekly-recap-done" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default function WeeklyRecap() {
  const { isPro, loading: proLoading } = useProContext()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.get('/recap/weekly')
      .then((res) => setData(res.data || null))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  return (
    <ProGate isPro={isPro} loading={proLoading} message="Weekly Recap is a Pro feature">
      <div className="space-y-4">
        {loading ? <LoadingRunner message="Loading weekly recap" /> : <WeeklyRecapPresenter data={data} />}
        {!loading && (
          <div className="weekly-recap-page-actions">
            <Link to="/">Back to Dashboard</Link>
            <Link to="/history">View History</Link>
          </div>
        )}
      </div>
    </ProGate>
  )
}
