import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useUnits } from '../context/UnitsContext'
import api from '../lib/api'
import { getPaceZone } from '../lib/athleteLanguage'

export default function RunHub() {
  const { fmt } = useUnits()
  const [latestRun, setLatestRun] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/runs')
      .then((res) => {
        const runs = Array.isArray(res.data) ? res.data : res.data?.runs || []
        setLatestRun(runs[0] || null)
      })
      .catch(() => setLatestRun(null))
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
