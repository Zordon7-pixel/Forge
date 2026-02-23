import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import api from '../lib/api'
import MuscleDiagram from '../components/MuscleDiagram'
import { getMuscleBreakdown } from '../lib/muscleMap'
import PhotoUploader from '../components/PhotoUploader'

function fmtDuration(s) {
  if (!s && s !== 0) return '--'
  const safe = Math.max(0, Math.round(s || 0))
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const sec = safe % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${sec}s`
}

const StatRow = ({ label, value }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 12, paddingBottom: 12, borderBottom: '1px solid var(--border-subtle)' }}>
    <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{label}</span>
    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{value}</span>
  </div>
)

const SectionHeader = ({ label }) => (
  <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 24, marginBottom: 4 }}>{label}</p>
)

function parseSecondaryMuscles(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map((m) => String(m).trim().toLowerCase()).filter(Boolean)
  return String(raw)
    .split(',')
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean)
}

export default function WorkoutSummary() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [session, setSession] = useState(null)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [summaryTab, setSummaryTab] = useState('overview')
  const [sets, setSets] = useState([])

  useEffect(() => {
    api.get(`/workouts/${id}`).then((res) => {
      const workoutSession = res.data?.session || null
      setSession(workoutSession)
      setNotes(workoutSession?.notes || '')
    }).catch(() => navigate('/'))
      .finally(() => setLoading(false))
  }, [id, navigate])

  useEffect(() => {
    if (session?.id) {
      api.get(`/workouts/${session.id}/sets`).then((r) => setSets(r.data.sets || [])).catch(() => setSets([]))
    }
  }, [session?.id])

  const saveNotes = async () => {
    setSaving(true)
    try {
      await api.put(`/workouts/${id}/end`, { notes })
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } finally {
      setSaving(false)
    }
  }

  const exerciseMap = useMemo(() => {
    const map = {}
    for (const s of sets) {
      const key = s.exercise_name || 'Unknown Exercise'
      if (!map[key]) map[key] = []
      map[key].push(s)
    }
    return map
  }, [sets])

  const sessionMuscles = (session?.muscle_groups || []).map((m) => String(m).toLowerCase())
  const { primary } = getMuscleBreakdown(sessionMuscles)

  const derivedSecondary = useMemo(() => {
    const extras = new Set()
    for (const s of sets) {
      for (const m of parseSecondaryMuscles(s.secondary_muscles)) {
        if (!primary.includes(m)) extras.add(m)
      }
      if (s.muscle_group) {
        const mg = String(s.muscle_group).toLowerCase()
        if (!primary.includes(mg)) extras.add(mg)
      }
    }
    return [...extras]
  }, [sets, primary])

  const totalReps = sets.reduce((acc, s) => acc + (s.reps || 0), 0)
  const totalVolumeLbs = sets.reduce((acc, s) => acc + ((s.reps || 0) * (s.weight_lbs || 0)), 0)
  const totalCalories = Math.round(((session?.total_seconds || 0) / 60) * 5)
  const workTimeSec = sets.reduce((sum, set) => sum + (set.duration_seconds || 30), 0)
  const restTimeSec = (session?.total_seconds || 0) - workTimeSec

  if (loading) return <div className="p-4" style={{ color: 'var(--text-muted)' }}>Loading summary...</div>
  if (!session) return null

  return (
    <div className="space-y-4 pb-8">
      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
        <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Workout Complete</p>
        <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Summary</h2>

        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)', marginTop: 12, marginBottom: 20 }}>
          {['overview', 'stats', 'charts'].map((t) => (
            <button
              key={t}
              onClick={() => setSummaryTab(t)}
              style={{
                flex: 1,
                paddingTop: 10,
                paddingBottom: 10,
                fontSize: 13,
                fontWeight: 600,
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                textTransform: 'capitalize',
                color: summaryTab === t ? 'var(--text-primary)' : 'var(--text-muted)',
                borderBottom: summaryTab === t ? '2px solid var(--accent)' : '2px solid transparent'
              }}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {summaryTab === 'overview' && (
          <>
            <MuscleDiagram primaryMuscles={primary} secondaryMuscles={derivedSecondary} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
              <div style={{ background: 'var(--bg-input)', borderRadius: 12, padding: 16 }}>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Total Time</p>
                <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)' }}>{fmtDuration(session.total_seconds)}</p>
              </div>
              <div style={{ background: 'var(--bg-input)', borderRadius: 12, padding: 16 }}>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Calories</p>
                <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)' }}>{totalCalories || '--'}</p>
              </div>
              <div style={{ background: 'var(--bg-input)', borderRadius: 12, padding: 16 }}>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Total Sets</p>
                <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)' }}>{sets.length}</p>
              </div>
              <div style={{ background: 'var(--bg-input)', borderRadius: 12, padding: 16 }}>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Total Reps</p>
                <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)' }}>{totalReps}</p>
              </div>
            </div>

            <div style={{ marginTop: 20 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>Exercises</p>
              {Object.entries(exerciseMap).map(([name, exSets]) => (
                <div key={name} style={{ background: 'var(--bg-input)', borderRadius: 12, padding: 14, marginBottom: 8 }}>
                  <p style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', marginBottom: 8 }}>{name}</p>
                  {exSets.map((s, i) => (
                    <div key={s.id || `${name}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 4, paddingBottom: 4, borderTop: i > 0 ? '1px solid var(--border-subtle)' : 'none' }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Set {s.set_number || i + 1}</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                        {s.reps ? `${s.reps} reps` : '--'}{s.weight_lbs ? ` @ ${s.weight_lbs} lbs` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
              {sets.length === 0 && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>No sets logged.</p>}
            </div>
          </>
        )}

        {summaryTab === 'stats' && (
          <>
            <SectionHeader label="Timing" />
            <StatRow label="Total Time" value={fmtDuration(session.total_seconds)} />
            <StatRow label="Work Time" value={fmtDuration(workTimeSec)} />
            <StatRow label="Rest Time" value={fmtDuration(Math.max(0, restTimeSec))} />

            <SectionHeader label="Heart Rate" />
            <StatRow label="Avg Heart Rate" value={session.avg_heart_rate ? `${session.avg_heart_rate} bpm` : '--'} />
            <StatRow label="Max Heart Rate" value={session.max_heart_rate ? `${session.max_heart_rate} bpm` : '--'} />

            <SectionHeader label="Training Effect" />
            <StatRow label="Aerobic" value={session.aerobic_effect ?? '--'} />
            <StatRow label="Anaerobic" value={session.anaerobic_effect ?? '--'} />
            <StatRow label="Exercise Load" value={session.exercise_load ?? '--'} />

            <SectionHeader label="Nutrition" />
            <StatRow label="Resting Cal" value={Math.round((session.total_seconds || 0) / 60)} />
            <StatRow label="Active Cal" value={totalCalories} />
            <StatRow label="Total Cal Burned" value={totalCalories + Math.round((session.total_seconds || 0) / 60)} />

            <SectionHeader label="Workout Details" />
            <StatRow label="Total Reps" value={totalReps} />
            <StatRow label="Total Sets" value={sets.length} />
            <StatRow label="Total Volume" value={totalVolumeLbs > 0 ? `${totalVolumeLbs.toLocaleString()} lbs` : '--'} />
          </>
        )}

        {summaryTab === 'charts' && (
          <div style={{ marginTop: 8 }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 }}>Sets Per Exercise</p>
            {Object.entries(exerciseMap).map(([name, exSets]) => {
              const maxSets = Math.max(...Object.values(exerciseMap).map((s) => s.length))
              const pct = maxSets > 0 ? (exSets.length / maxSets) * 100 : 0
              return (
                <div key={name} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>{name}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{exSets.length} sets</span>
                  </div>
                  <div style={{ height: 6, background: 'var(--bg-input)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: '#EF4444', borderRadius: 3, transition: 'width 0.5s ease' }} />
                  </div>
                </div>
              )
            })}
            {Object.keys(exerciseMap).length === 0 && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>No exercise chart data available.</p>}
          </div>
        )}

        <div className="mt-4">
          <PhotoUploader activityId={session.id} activityType="lift" />
        </div>
      </div>

      <div className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-card)' }}>
        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Workout Notes</p>
        <textarea
          rows={3}
          placeholder="How did it feel? Any PRs? Anything to note..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full rounded-xl px-4 py-3 border text-sm"
          style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
        />
        <button
          onClick={saveNotes}
          disabled={saving}
          className="rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'black' }}
        >
          {saving ? 'Saving...' : saved ? 'Saved' : 'Save Notes'}
        </button>
      </div>

      <Link to="/" className="block w-full rounded-2xl py-4 text-center font-bold border" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
        Back to Home
      </Link>
    </div>
  )
}
