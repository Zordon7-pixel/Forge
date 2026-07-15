import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import api from '../lib/api'
import LoadingRunner from '../components/LoadingRunner'
import RunDetailModal from '../components/RunDetailModal'
import RunMediaManager from '../components/RunMediaManager'

export default function RunRecap() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [run, setRun] = useState(null)
  const [hrZones, setHrZones] = useState([])
  const [hrProfile, setHrProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    Promise.all([
      api.get(`/runs/${encodeURIComponent(id)}`),
      api.get('/profile/hr-zones').catch((requestError) => {
        console.error('[RunRecap] heart-rate profile unavailable:', requestError?.message || requestError)
        return { data: { zones: [], profile: null } }
      }),
    ])
      .then(([runResponse, zonesResponse]) => {
        if (!active) return
        setRun(runResponse.data?.run || null)
        setHrZones(Array.isArray(zonesResponse.data?.zones) ? zonesResponse.data.zones : [])
        setHrProfile(zonesResponse.data?.profile || null)
      })
      .catch((requestError) => {
        console.error('[RunRecap] load failed:', requestError?.message || requestError)
        if (active) setError(requestError?.response?.data?.error || 'Could not load this run recap.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => { active = false }
  }, [id])

  if (loading) return <LoadingRunner message="Loading run recap" />

  if (!run) {
    return (
      <div className="mx-auto max-w-md pt-10 text-center">
        <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Run recap unavailable</h1>
        <p className="mt-2 text-sm" role="alert" style={{ color: 'var(--text-muted)' }}>{error}</p>
        <Link to="/history" className="mt-5 inline-flex rounded-xl px-4 py-3 text-sm font-semibold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>Open history</Link>
      </div>
    )
  }

  return (
    <div className="pt-2">
      <RunDetailModal
        standalone
        run={run}
        hrZones={hrZones}
        hrProfile={hrProfile}
        onClose={() => navigate('/history')}
        onFeedbackGenerated={(runId, feedback) => {
          if (runId === run.id) setRun((current) => ({ ...current, ai_feedback: feedback }))
        }}
      />
      <RunMediaManager runId={run.id} />
      <div className="mx-auto grid w-full max-w-2xl grid-cols-2 gap-3 pb-6">
        <Link to="/stretches/session?type=post" className="rounded-xl px-4 py-3 text-center text-sm font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>Start recovery</Link>
        <Link to="/" className="rounded-xl border px-4 py-3 text-center text-sm font-semibold" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}>Done</Link>
      </div>
    </div>
  )
}
