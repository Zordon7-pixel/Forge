import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, Lightbulb } from 'lucide-react'
import { useUnits } from '../context/UnitsContext'
import api from '../lib/api'
import { getPaceZone } from '../lib/athleteLanguage'

export default function RunHub() {
  const { fmt } = useUnits()
  const [latestRun, setLatestRun] = useState(null)
  const [recommendation, setRecommendation] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      api.get('/runs'),
      api.get('/runs/next-recommendation').catch(() => ({ data: null })),
    ])
      .then(([runsRes, recRes]) => {
        const runs = Array.isArray(runsRes.data) ? runsRes.data : runsRes.data?.runs || []
        setLatestRun(runs[0] || null)
        setRecommendation(recRes.data || null)
      })
      .catch(() => {
        setLatestRun(null)
        setRecommendation(null)
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

  const recommendationTarget = useMemo(() => {
    if (!recommendation) return '/log-run'
    if (recommendation.recommendationType === 'strength') return '/log-lift'
    if (recommendation.recommendationType === 'rest') return '/plan'
    const params = new URLSearchParams()
    if (Number(recommendation.suggestedDistance || 0) > 0) params.set('distance', String(recommendation.suggestedDistance))
    if (recommendation.recommendationType) params.set('type', String(recommendation.recommendationType))
    if (recommendation.suggestedPace) params.set('pace', String(recommendation.suggestedPace))
    return `/log-run${params.toString() ? `?${params.toString()}` : ''}`
  }, [recommendation])

  return (
    <div className="space-y-4 py-2">
      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
        <h2 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>Run Hub</h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Your last run translated into runner language.</p>
      </div>

      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>Loading run stats...</p>
        ) : !latestRun ? (
          <p style={{ color: 'var(--text-muted)' }}>No runs yet. Log one to see your pace zone.</p>
        ) : (
          <>
            <p className="text-sm mb-1" style={{ color: 'var(--text-muted)' }}>Latest Pace</p>
            <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
              {paceText}
              {paceZone && (
                <span style={{ color: paceZone.color }}>
                  {' '}· Zone {paceZone.zone} {paceZone.label}
                </span>
              )}
            </p>
            {paceZone && <p className="text-sm mt-2" style={{ color: paceZone.color }}>{paceZone.description}</p>}
          </>
        )}
      </div>

      {recommendation && (
        <Link
          to={recommendationTarget}
          className="block rounded-2xl p-4"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', textDecoration: 'none' }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Lightbulb size={15} color="#EAB308" />
              <p className="text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>
                Today&apos;s Recommendation
              </p>
            </div>
            <ChevronRight size={15} color="var(--text-muted)" />
          </div>
          <p className="text-sm font-bold mt-2 capitalize" style={{ color: 'var(--text-primary)' }}>
            {String(recommendation.recommendationType || '').replace('_', ' ')}
            {Number(recommendation.suggestedDistance || 0) > 0 ? ` · ${recommendation.suggestedDistance} mi` : ''}
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{recommendation.reason}</p>
        </Link>
      )}

      {latestRun && (
        <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <p className="text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>Recent Run Snapshot</p>
          <div className="mt-3 grid grid-cols-3 gap-2">
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
      )}

      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <p className="text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>Quick Actions</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Link to="/warmup" className="rounded-xl py-2 text-center text-sm font-semibold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', textDecoration: 'none' }}>
            Start Warm-Up
          </Link>
          <Link to="/history" className="rounded-xl py-2 text-center text-sm font-semibold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', textDecoration: 'none' }}>
            View History
          </Link>
        </div>
      </div>

      <Link
        to="/log-run"
        className="block w-full rounded-xl py-3 text-center font-semibold"
        style={{ background: 'var(--accent)', color: '#000' }}
      >
        Open Run Logger
      </Link>
    </div>
  )
}
