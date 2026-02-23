import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import api from '../lib/api'
import MuscleDiagram from '../components/MuscleDiagram'
import { getMuscleBreakdown } from '../lib/muscleMap'

function fmtDuration(s) {
  if (!s) return '--'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${sec}s`
}

export default function WorkoutSummary() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [userSex, setUserSex] = useState('male')

  useEffect(() => {
    api.get('/auth/me').then(res => setUserSex(res.data.user?.sex || 'male')).catch(() => {})
  }, [])

  useEffect(() => {
    api.get(`/workouts/${id}`).then(res => {
      setData(res.data)
      setNotes(res.data?.session?.notes || '')
    }).catch(() => navigate('/'))
      .finally(() => setLoading(false))
  }, [id, navigate])

  const saveNotes = async () => {
    setSaving(true)
    try {
      await api.put(`/workouts/${id}/end`, { notes })
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch {} finally { setSaving(false) }
  }

  if (loading) return <div className="p-4" style={{ color: 'var(--text-muted)' }}>Loading summary...</div>
  if (!data) return null

  const { session, sets } = data
  const muscleGroups = session.muscle_groups || []
  const { primary, secondary } = getMuscleBreakdown(muscleGroups)

  const byExercise = sets.reduce((acc, s) => {
    if (!acc[s.exercise_name]) acc[s.exercise_name] = []
    acc[s.exercise_name].push(s)
    return acc
  }, {})

  const totalVolume = sets.reduce((sum, s) => sum + (s.reps || 0) * (s.weight_lbs || 0), 0)
  const totalSets = sets.length

  return (
    <div className="space-y-4 pb-8">
      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
        <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Workout Complete</p>
        <h2 className="text-2xl font-bold" style={{ color: 'var(--accent)' }}>Summary</h2>
        <div className="grid grid-cols-3 gap-3 mt-3">
          <div className="text-center">
            <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{fmtDuration(session.total_seconds)}</p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Duration</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{totalSets}</p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Sets</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{totalVolume.toLocaleString()} lbs</p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Volume</p>
          </div>
        </div>
      </div>

      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
        <p className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Muscles Targeted</p>
        <div className="flex gap-4 items-start">
          <MuscleDiagram primaryMuscles={primary} secondaryMuscles={secondary} sex={userSex} />
          <div className="flex-1 space-y-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide mb-1" style={{ color: 'var(--accent)' }}>Primary</p>
              <div className="flex flex-wrap gap-2">
                {primary.map(m => (
                  <span key={m} className="rounded-full px-3 py-1 text-xs font-semibold capitalize" style={{ background: 'var(--accent)', color: 'black' }}>{m}</span>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)' }}>Secondary</p>
              <div className="flex flex-wrap gap-2">
                {secondary.map(m => (
                  <span key={m} className="rounded-full px-3 py-1 text-xs capitalize" style={{ background: 'var(--accent-dim)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>{m}</span>
                ))}
                {secondary.length === 0 && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>—</span>}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-card)' }}>
        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Exercises</p>
        {Object.entries(byExercise).map(([name, exSets]) => {
          const bestSet = exSets.reduce((best, s) => (!best || (s.weight_lbs || 0) > best.weight_lbs) ? s : best, null)
          const totalVol = exSets.reduce((s, ex) => s + (ex.reps || 0) * (ex.weight_lbs || 0), 0)
          return (
            <div key={name} className="rounded-xl p-3" style={{ background: 'var(--bg-input)' }}>
              <p className="font-semibold text-sm mb-2" style={{ color: 'var(--text-primary)' }}>{name}</p>
              <div className="flex flex-wrap gap-2 mb-2">
                {exSets.map((s, i) => (
                  <span key={s.id} className="text-xs px-2 py-1 rounded-lg" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>
                    Set {i + 1}: {s.reps} × {s.weight_lbs}lbs
                  </span>
                ))}
              </div>
              <div className="flex gap-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                <span>Best: {bestSet?.weight_lbs}lbs</span>
                <span>Volume: {totalVol.toLocaleString()}lbs</span>
              </div>
            </div>
          )
        })}
        {sets.length === 0 && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No sets logged.</p>}
      </div>

      <div className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-card)' }}>
        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Workout Notes</p>
        <textarea
          rows={3}
          placeholder="How did it feel? Any PRs? Anything to note..."
          value={notes}
          onChange={e => setNotes(e.target.value)}
          className="w-full rounded-xl px-4 py-3 border text-sm"
          style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
        />
        <button onClick={saveNotes} disabled={saving}
          className="rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'black' }}>
          {saving ? 'Saving...' : saved ? 'Saved' : 'Save Notes'}
        </button>
      </div>

      <Link to="/" className="block w-full rounded-2xl py-4 text-center font-bold border" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
        Back to Home
      </Link>
    </div>
  )
}
