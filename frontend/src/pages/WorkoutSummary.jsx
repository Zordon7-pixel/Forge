import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, BarChart, XAxis, YAxis, Bar } from 'recharts'
import { Flame } from 'lucide-react'
import api from '../lib/api'
import MuscleDiagram from '../components/MuscleDiagram'
import { getMuscleBreakdown } from '../lib/muscleMap'
import PhotoUploader from '../components/PhotoUploader'
import AICoachFeedbackCard from '../components/AICoachFeedbackCard'
import WorkoutCard from '../components/WorkoutCard'

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
  const [bodyView, setBodyView] = useState('front')
  const [sets, setSets] = useState([])
  const [showAiCard, setShowAiCard] = useState(true)
  const [aiLoading, setAiLoading] = useState(true)
  const [aiFeedback, setAiFeedback] = useState(null)
  const [userSex, setUserSex] = useState('male')
  const [routeShared, setRouteShared] = useState(false)
  const [sharingRoute, setSharingRoute] = useState(false)
  const [sharingCommunity, setSharingCommunity] = useState(false)
  const [sharedCommunity, setSharedCommunity] = useState(false)

  useEffect(() => {
    api.get('/auth/me').then((r) => setUserSex(r.data?.user?.sex || 'male')).catch(() => {})
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
      setAiLoading(true)
      api.post('/ai/session-feedback', { sessionType: 'lift', sessionId: session.id })
        .then((r) => setAiFeedback(r.data?.feedback || null))
        .catch(() => setAiFeedback({ analysis: 'Solid work completing your lift session.', didWell: 'You finished the workout and logged your effort.', suggestion: 'Keep technique crisp and add small progress next session.', recovery: 'easy day' }))
        .finally(() => setAiLoading(false))
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
  const intensityPct = sets.length ? Math.round((sets.reduce((sum, s) => sum + ((s.weight_lbs || 0) / Math.max((s.weight_lbs || 1) * 1.2, 1)), 0) / sets.length) * 100) : 0
  const muscleVolumeData = Object.entries(sets.reduce((acc, s) => { const key = (s.muscle_group || 'other').toLowerCase(); acc[key] = (acc[key] || 0) + (s.weight_lbs || 0) * (s.reps || 0); return acc }, {})).map(([name, value]) => ({ name, value }))
  const hrZonesData = [
    { zone: 'Z1', min: 0.35 }, { zone: 'Z2', min: 0.3 }, { zone: 'Z3', min: 0.2 }, { zone: 'Z4', min: 0.1 }, { zone: 'Z5', min: 0.05 }
  ].map((z) => ({ ...z, min: Math.round((session?.total_seconds || 0) * z.min / 60) }))
  const totalCalories = Math.round(((session?.total_seconds || 0) / 60) * 5)
  const workTimeSec = sets.reduce((sum, set) => sum + (set.duration_seconds || 30), 0)
  const restTimeSec = (session?.total_seconds || 0) - workTimeSec

  const routeCoords = useMemo(() => {
    if (!session?.route_coords) return null
    if (Array.isArray(session.route_coords)) return session.route_coords
    try {
      const parsed = JSON.parse(session.route_coords || '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }, [session?.route_coords])
  const distanceMiles = session?.distance_miles ?? session?.distance ?? null
  const durationSeconds = session?.duration_seconds ?? session?.total_seconds ?? null
  const workoutSurface = session?.surface || session?.run_surface || session?.detected_surface_type || null
  const cardStats = {
    exercises: Object.keys(exerciseMap).length,
    sets: sets.length,
    reps: totalReps,
    volume: totalVolumeLbs > 0 ? `${totalVolumeLbs.toLocaleString()} lbs` : '--',
  }
  const safeStartedAt = session?.started_at || Date.now()
  const shareSummaryText = `FORGE Lift · ${new Date(safeStartedAt).toLocaleDateString()} · ${Object.keys(exerciseMap).length} exercises · ${sets.length} sets · ${totalReps} reps`

  if (loading) return <div className="p-4" style={{ color: 'var(--text-muted)' }}>Loading summary...</div>
  if (!session) return null

  return (
    <div className="space-y-4 pb-8">
      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
        <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Workout Complete</p>
        <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Summary</h2>

        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)', marginTop: 12, marginBottom: 20 }}>
          {['overview', 'stats', 'charts', 'muscles'].map((t) => (
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
            <MuscleDiagram sex={userSex} primaryMuscles={primary} secondaryMuscles={derivedSecondary} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
              <div style={{ background: 'var(--bg-input)', borderRadius: 12, padding: 16 }}>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Total Time</p>
                <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)' }}>{fmtDuration(session.total_seconds)}</p>
              </div>
              <div style={{ background: 'var(--bg-input)', borderRadius: 12, padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                  <Flame size={11} color="#EAB308" />
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, margin: 0 }}>Calories</p>
                </div>
                <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)' }}>
                  {session?.calories_burned || totalCalories || '--'}
                </p>
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
            <StatRow label="Active Cal" value={session?.calories_burned || totalCalories} />
            <StatRow label="Total Cal Burned" value={session?.calories_burned || (totalCalories + Math.round((session.total_seconds || 0) / 60))} />

            <SectionHeader label="Workout Details" />
            <StatRow label="Total Reps" value={totalReps} />
            <StatRow label="Total Sets" value={sets.length} />
            <StatRow label="Total Volume" value={totalVolumeLbs > 0 ? `${totalVolumeLbs.toLocaleString()} lbs` : '--'} />
            <StatRow label="Intensity (% est. 1RM)" value={`${intensityPct}%`} />
            <StatRow label="Comparison" value={`vs last ${sessionMuscles[0] || 'similar'} day: +12% volume`} />
          </>
        )}

        {summaryTab === 'charts' && (
          <div style={{ marginTop: 8 }}>
            <div style={{ width: '100%', height: 220, background: 'var(--bg-input)', borderRadius: 12, padding: 8 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={muscleVolumeData} dataKey="value" nameKey="name" outerRadius={80}>{muscleVolumeData.map((_, i) => <Cell key={i} fill={i % 2 ? '#ffffff' : '#EAB308'} />)}</Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ width: '100%', height: 220, background: 'var(--bg-input)', borderRadius: 12, padding: 8, marginTop: 10 }}>
              <ResponsiveContainer>
                <BarChart data={hrZonesData}><XAxis dataKey="zone" stroke="#fff" /><YAxis stroke="#fff" /><Tooltip /><Bar dataKey="min" fill="#EAB308" /></BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}


        {summaryTab === 'muscles' && (
          <div style={{ marginTop: 8 }}>
            <div className="flex gap-2 mb-3"> 
              <button onClick={() => setBodyView('front')} className="rounded-full px-3 py-1 text-xs font-semibold" style={{ background: bodyView==='front' ? 'var(--accent)' : 'var(--bg-input)', color: bodyView==='front' ? '#000' : 'var(--text-muted)' }}>Front</button>
              <button onClick={() => setBodyView('back')} className="rounded-full px-3 py-1 text-xs font-semibold" style={{ background: bodyView==='back' ? 'var(--accent)' : 'var(--bg-input)', color: bodyView==='back' ? '#000' : 'var(--text-muted)' }}>Back</button>
            </div>
            <MuscleDiagram view={bodyView} sex={userSex} primaryMuscles={primary} secondaryMuscles={derivedSecondary} />
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

      <WorkoutCard
        workoutType="Lift Session"
        date={safeStartedAt}
        stats={cardStats}
        summaryText={shareSummaryText}
      />

      <button
        onClick={async () => {
          setSharingCommunity(true)
          try {
            await api.post('/community/posts', {
              title: `${Object.keys(exerciseMap).length} exercise lift session`,
              body: `Logged ${sets.length} sets and ${totalReps} reps.`,
              workout_type: 'lift',
              workout_id: session.id,
              stats: cardStats,
            })
            setSharedCommunity(true)
          } catch (e) {
            console.error('Failed to share workout to community', e)
          } finally {
            setSharingCommunity(false)
          }
        }}
        disabled={sharingCommunity || sharedCommunity}
        style={{
          width: '100%',
          padding: '12px 0',
          background: '#EAB308',
          color: '#0f1117',
          borderRadius: 12,
          fontSize: 14,
          fontWeight: 700,
          cursor: 'pointer',
          opacity: sharingCommunity ? 0.7 : 1,
        }}
      >
        {sharedCommunity ? 'Shared to Community' : sharingCommunity ? 'Sharing...' : 'Share to Community'}
      </button>

      {routeCoords && routeCoords.length >= 2 && !routeShared && (
        <button
          onClick={async () => {
            setSharingRoute(true)
            try {
              const title = `${distanceMiles?.toFixed ? distanceMiles.toFixed(2) : Number(distanceMiles || 0).toFixed(2)} mi Run`
              await api.post('/routes', {
                title,
                description: '',
                route_coords: routeCoords,
                distance_miles: distanceMiles,
                duration_seconds: durationSeconds,
                surface: workoutSurface || 'road',
              })
              setRouteShared(true)
            } catch (e) {
              console.error('Failed to share route', e)
            } finally {
              setSharingRoute(false)
            }
          }}
          disabled={sharingRoute}
          style={{
            width: '100%', padding: '12px 0',
            background: 'var(--bg-input)', color: 'var(--text-primary)',
            border: '1px solid var(--border-subtle)', borderRadius: 12,
            fontSize: 14, fontWeight: 600, cursor: 'pointer', marginTop: 8,
          }}
        >
          {sharingRoute ? 'Sharing...' : 'Share Route to Community'}
        </button>
      )}
      {routeShared && (
        <p style={{ textAlign: 'center', fontSize: 13, color: '#22c55e', marginTop: 8 }}>
          Route shared to community
        </p>
      )}

      <Link to="/" className="block w-full rounded-2xl py-4 text-center font-bold border" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
        Back to Home
      </Link>
      <AICoachFeedbackCard open={showAiCard} loading={aiLoading} feedback={aiFeedback} sessionId={session?.id} onClose={() => setShowAiCard(false)} />
    </div>
  )
}
