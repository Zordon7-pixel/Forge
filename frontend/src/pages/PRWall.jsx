import { useEffect, useMemo, useState } from 'react'
import api from '../lib/api'
import LoadingRunner from '../components/LoadingRunner'
import { Pencil } from 'lucide-react'

const baseCardStyle = {
  background: 'var(--bg-card)',
  borderRadius: 16,
  padding: '16px',
  border: '1px solid var(--border-subtle)'
}

const liftingLabels = ['Best Bench Press', 'Best Squat', 'Best Deadlift']

const RUNNING_PR_LABELS = [
  { label: '1 Mile PR',           unit: 'min/mi' },
  { label: '5K PR',               unit: 'min/mi' },
  { label: '10K PR',              unit: 'min/mi' },
  { label: 'Half Marathon PR',    unit: 'min/mi' },
  { label: 'Marathon PR',         unit: 'min/mi' },
  { label: 'Longest Run',         unit: 'mi' },
  { label: 'Fastest Mile',        unit: 'min/mi' },
  { label: 'Best Avg Pace',       unit: 'min/mi' },
  { label: 'Most Miles in a Week',unit: 'mi' },
]

const LIFTING_PR_LABELS = [
  { label: 'Best Bench Press',    unit: 'lbs' },
  { label: 'Best Squat',          unit: 'lbs' },
  { label: 'Best Deadlift',       unit: 'lbs' },
  { label: 'Best Overhead Press', unit: 'lbs' },
  { label: 'Best Pull-Up',        unit: 'reps' },
  { label: 'Best Barbell Row',    unit: 'lbs' },
  { label: 'Best Incline Press',  unit: 'lbs' },
  { label: 'Best Leg Press',      unit: 'lbs' },
  { label: 'Best Hip Thrust',     unit: 'lbs' },
  { label: 'Best Dumbbell Curl',  unit: 'lbs' },
]

function formatValue(pr) {
  const unit = (pr?.unit || '').toLowerCase()
  const value = Number(pr?.value || 0)

  if (unit === 'min/mi') {
    const mins = Math.floor(value)
    const secs = Math.round((value - mins) * 60)
    return `${mins}:${String(secs).padStart(2, '0')} min/mi`
  }

  if (unit === 'mi') return `${value.toFixed(2)} mi`
  if (unit === 'lbs' || unit === 'lb') return `${Math.round(value)} lbs`
  if (unit === 'reps' || unit === 'rep') return `${Math.round(value)} reps`

  return `${value} ${pr?.unit || ''}`.trim()
}

function secondsToHMS(seconds) {
  if (!seconds || seconds < 0) return '--'
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = Math.round(seconds % 60)
  
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function secondsToMinPerMile(seconds, distance) {
  if (!seconds || !distance || distance <= 0) return null
  return seconds / 60 / distance
}

function hmsToSeconds(hms) {
  if (!hms) return 0
  const parts = hms.split(':').map(p => parseInt(p, 10))
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1]
  }
  return parseInt(hms, 10) || 0
}

function isSuspiciousPace(paceMinPerMile) {
  if (!paceMinPerMile) return false
  // World record thresholds (min/mile)
  const wrThresholds = {
    '1 Mile': 3.717, // 3:43/mi
    '5K': 4.067, // 4:04/mi (12:38 total / 3.107 mi)
    '10K': 4.25, // 4:15/mi (26:24 total / 6.214 mi)
    '15K': 4.383, // 4:23/mi (57:31 / 9.321)
    'Half Marathon': 4.393, // 4:23/mi (57:31 / 13.109)
    'Marathon': 4.6 // 4:36/mi (2:00:35 / 26.219)
  }
  // For now, return true if pace is absurdly fast (less than 3:30/mi)
  return paceMinPerMile < 3.5
}

export default function PRWall() {
  const [prs, setPrs] = useState([])
  const [totalMiles, setTotalMiles] = useState(0)
  const [timePRs, setTimePRs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [showModal, setShowModal] = useState(false)
  const [editingTimePR, setEditingTimePR] = useState(null)
  const [timeEditForm, setTimeEditForm] = useState({ time_hms: '', date: new Date().toISOString().slice(0, 10) })
  const [form, setForm] = useState({
    category: 'run',
    label: RUNNING_PR_LABELS[0].label,
    value: '',
    unit: RUNNING_PR_LABELS[0].unit,
    achieved_at: new Date().toISOString().slice(0, 10),
    notes: ''
  })

  const loadData = async () => {
    setLoading(true)
    setError('')
    try {
      const runsRes = await api.get('/runs?limit=1')
      const runs = runsRes.data?.runs || []
      if (runs[0]?.id) {
        await api.post('/prs/auto-detect', { run_id: runs[0].id }).catch(() => {})
      }

      const [prsRes, allRunsRes, timePRRes] = await Promise.all([
        api.get('/prs'),
        api.get('/runs'),
        api.get('/prs/time').catch(() => ({ data: { times: [] } }))
      ])

      const prList = prsRes.data?.prs || []
      const allRuns = allRunsRes.data?.runs || []
      const times = timePRRes.data?.times || []
      const miles = allRuns.reduce((sum, run) => sum + (Number(run.distance_miles) || 0), 0)

      setPrs(prList)
      setTimePRs(times)
      setTotalMiles(miles)
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not load PRs right now.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runningPRs = useMemo(() => prs.filter(pr => pr.category === 'run'), [prs])
  const liftingPRs = useMemo(() => prs.filter(pr => pr.category === 'lift'), [prs])

  const submitPR = async e => {
    e.preventDefault()
    try {
      await api.post('/prs', {
        ...form,
        value: Number(form.value)
      })
      setShowModal(false)
      setForm({
        category: 'run',
        label: '',
        value: '',
        unit: 'mi',
        achieved_at: new Date().toISOString().slice(0, 10),
        notes: ''
      })
      await loadData()
    } catch (e2) {
      setError(e2?.response?.data?.error || 'Could not add PR.')
    }
  }

  const removePR = async id => {
    try {
      await api.delete(`/prs/${id}`)
      setPrs(prev => prev.filter(pr => pr.id !== id))
    } catch {
      setError('Could not delete PR.')
    }
  }

  const saveTimePR = async (distance, distanceMiles) => {
    try {
      const timeSeconds = hmsToSeconds(timeEditForm.time_hms)
      if (timeSeconds <= 0) {
        setError('Invalid time format')
        return
      }

      await api.post('/prs/manual', {
        distance_miles: distanceMiles,
        time_seconds: timeSeconds,
        date: timeEditForm.date
      })

      setEditingTimePR(null)
      setTimeEditForm({ time_hms: '', date: new Date().toISOString().slice(0, 10) })
      await loadData()
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not save time PR.')
    }
  }

  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black" style={{ color: 'var(--text-primary)' }}>PR Wall</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Your best performances, ever.</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="rounded-xl px-4 py-2 text-sm font-bold"
          style={{ background: 'var(--accent)', color: '#000' }}
        >
          + Add PR
        </button>
      </div>

      {error && <p className="mb-4 text-sm" style={{ color: 'var(--accent)' }}>{error}</p>}
      {loading ? (
        <LoadingRunner message="Loading records" />
      ) : (
        <>
          <section className="mb-6">
            <h2 className="mb-3 text-lg font-bold">Running PRs</h2>
            <div className="grid grid-cols-1 gap-3">
              <div style={baseCardStyle}>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>Total Miles</p>
                <p style={{ fontSize: 28, fontWeight: 900, color: 'var(--accent)' }}>{totalMiles.toFixed(2)} mi</p>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>All-time running volume</p>
              </div>

              {runningPRs.length === 0 ? (
                <div style={baseCardStyle}>
                  <p style={{ color: 'var(--text-muted)' }}>No running PRs yet. Log a run or add one manually.</p>
                </div>
              ) : (
                runningPRs.map(pr => (
                  <div key={pr.id} style={baseCardStyle}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>{pr.label}</p>
                      {pr.run_id ? (
                        <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: 'rgba(234,179,8,0.2)', color: 'var(--accent)' }}>Auto</span>
                      ) : (
                        <button onClick={() => removePR(pr.id)} className="text-xs" style={{ color: 'var(--text-muted)' }}>Delete</button>
                      )}
                    </div>
                    <p style={{ fontSize: 28, fontWeight: 900, color: 'var(--accent)' }}>{formatValue(pr)}</p>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{new Date(pr.achieved_at).toLocaleDateString()}</p>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="mb-6">
            <h2 className="mb-3 text-lg font-bold">Time PRs</h2>
            <div className="grid grid-cols-1 gap-3">
              {[
                { label: '1 Mile', target: 1.0 },
                { label: '5K', target: 3.107 },
                { label: '10K', target: 6.214 },
                { label: '15K', target: 9.321 },
                { label: 'Half Marathon', target: 13.109 },
                { label: 'Marathon', target: 26.219 }
              ].map(dist => {
                const pr = timePRs.find(t => t.distance === dist.label)

                if (editingTimePR === dist.label) {
                  return (
                    <div key={dist.label} style={baseCardStyle}>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>{dist.label}</p>
                      <div className="space-y-2 mb-3">
                        <input
                          type="text"
                          placeholder="HH:MM:SS or MM:SS"
                          value={timeEditForm.time_hms}
                          onChange={e => setTimeEditForm(prev => ({ ...prev, time_hms: e.target.value }))}
                          className="w-full rounded-lg border px-2 py-1 text-sm"
                          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
                        />
                        <input
                          type="date"
                          value={timeEditForm.date}
                          onChange={e => setTimeEditForm(prev => ({ ...prev, date: e.target.value }))}
                          className="w-full rounded-lg border px-2 py-1 text-sm"
                          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => saveTimePR(dist.label, dist.target)}
                            className="flex-1 rounded-lg px-2 py-1 text-xs font-bold"
                            style={{ background: 'var(--accent)', color: '#000', border: 'none', cursor: 'pointer' }}
                          >
                            Save
                          </button>
                          <button
                            onClick={() => {
                              setEditingTimePR(null)
                              setTimeEditForm({ time_hms: '', date: new Date().toISOString().slice(0, 10) })
                            }}
                            className="flex-1 rounded-lg border px-2 py-1 text-xs"
                            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'none', cursor: 'pointer' }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                }

                if (!pr || !pr.best_time_seconds) {
                  return (
                    <div key={dist.label} style={baseCardStyle}>
                      <div className="mb-2 flex items-center justify-between">
                        <p style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>{dist.label}</p>
                        <button
                          onClick={() => {
                            setEditingTimePR(dist.label)
                            setTimeEditForm({ time_hms: '', date: new Date().toISOString().slice(0, 10) })
                          }}
                          className="rounded-lg p-1.5"
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
                        >
                          <Pencil size={14} />
                        </button>
                      </div>
                      <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-muted)' }}>--</p>
                      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>No PR yet — log a run to set it</p>
                    </div>
                  )
                }

                const pacePerMile = secondsToMinPerMile(pr.best_time_seconds, dist.target)
                const paceStr = pacePerMile ? `${Math.floor(pacePerMile)}:${String(Math.round((pacePerMile - Math.floor(pacePerMile)) * 60)).padStart(2, '0')}/mi` : 'N/A'
                const suspicious = isSuspiciousPace(pacePerMile)

                return (
                  <div key={dist.label} style={baseCardStyle}>
                    <div className="mb-1 flex items-center justify-between">
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>{dist.label}</p>
                      <button
                        onClick={() => {
                          setEditingTimePR(dist.label)
                          setTimeEditForm({ time_hms: secondsToHMS(pr.best_time_seconds), date: pr.date })
                        }}
                        className="rounded-lg p-1.5"
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
                      >
                        <Pencil size={14} />
                      </button>
                    </div>
                    <p style={{ fontSize: 28, fontWeight: 900, color: 'var(--accent)' }}>
                      {secondsToHMS(pr.best_time_seconds)}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{paceStr}</p>
                      {suspicious && <span style={{ fontSize: 10, color: 'var(--accent)' }}>(check data)</span>}
                    </div>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{new Date(pr.date).toLocaleDateString()}</p>
                  </div>
                )
              })}
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-bold">Lifting PRs</h2>
            <div className="grid grid-cols-1 gap-3">
              {liftingLabels.map(label => {
                const pr = liftingPRs.find(item => item.label === label)

                const openEntryModal = () => {
                  setForm({ category: 'lift', label, value: pr ? String(pr.value) : '', unit: 'lbs', achieved_at: new Date().toISOString().slice(0, 10), notes: '' })
                  setShowModal(true)
                }

                if (!pr) {
                  return (
                    <div key={label} style={baseCardStyle}>
                      <div className="flex items-center justify-between mb-2">
                        <p style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</p>
                        <button onClick={openEntryModal} className="rounded-lg px-3 py-1 text-xs font-bold" style={{ background: 'var(--accent)', color: '#000', border: 'none', cursor: 'pointer' }}>
                          + Add
                        </button>
                      </div>
                      <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-muted)' }}>--</p>
                      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>No record yet</p>
                    </div>
                  )
                }
                return (
                  <div key={pr.id} style={baseCardStyle}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>{pr.label}</p>
                      <div className="flex items-center gap-2">
                        <button onClick={openEntryModal} className="rounded-lg px-3 py-1 text-xs font-bold" style={{ background: 'var(--accent)', color: '#000', border: 'none', cursor: 'pointer' }}>
                          Update
                        </button>
                        {!pr.lift_id && (
                          <button onClick={() => removePR(pr.id)} className="text-xs" style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
                        )}
                      </div>
                    </div>
                    <p style={{ fontSize: 28, fontWeight: 900, color: 'var(--accent)' }}>{formatValue(pr)}</p>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{new Date(pr.achieved_at).toLocaleDateString()}</p>
                  </div>
                )
              })}

              {liftingPRs.filter(pr => !liftingLabels.includes(pr.label)).map(pr => (
                <div key={pr.id} style={baseCardStyle}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>{pr.label}</p>
                    {!pr.lift_id && (
                      <button onClick={() => removePR(pr.id)} className="text-xs" style={{ color: 'var(--text-muted)' }}>Delete</button>
                    )}
                  </div>
                  <p style={{ fontSize: 28, fontWeight: 900, color: 'var(--accent)' }}>{formatValue(pr)}</p>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{new Date(pr.achieved_at).toLocaleDateString()}</p>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-end" style={{ background: 'rgba(0,0,0,0.75)' }}>
          <div className="w-full rounded-t-2xl p-5 pb-10" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <h3 className="text-xl font-black mb-4" style={{ color: 'var(--text-primary)' }}>Add Personal Record</h3>
            <form className="space-y-3" onSubmit={submitPR}>

              {/* Category toggle */}
              <div className="flex gap-2">
                {[{ val: 'run', label: 'Running' }, { val: 'lift', label: 'Lifting' }].map(opt => (
                  <button
                    key={opt.val}
                    type="button"
                    onClick={() => {
                      const labels = opt.val === 'run' ? RUNNING_PR_LABELS : LIFTING_PR_LABELS
                      setForm(prev => ({ ...prev, category: opt.val, label: labels[0].label, unit: labels[0].unit }))
                    }}
                    style={{
                      flex: 1, padding: '10px 0', borderRadius: 12, fontWeight: 700, fontSize: 14,
                      background: form.category === opt.val ? 'var(--accent)' : 'var(--bg-input)',
                      color: form.category === opt.val ? '#000' : 'var(--text-muted)',
                      border: 'none', cursor: 'pointer'
                    }}
                  >{opt.label}</button>
                ))}
              </div>

              {/* Label dropdown — running or lifting options */}
              <div>
                <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>
                  {form.category === 'run' ? 'Race / Distance' : 'Exercise'}
                </p>
                <select
                  required
                  value={form.label}
                  onChange={e => {
                    const labels = form.category === 'run' ? RUNNING_PR_LABELS : LIFTING_PR_LABELS
                    const match = labels.find(l => l.label === e.target.value)
                    setForm(prev => ({ ...prev, label: e.target.value, unit: match?.unit || prev.unit }))
                  }}
                  className="w-full rounded-xl border px-3 py-2.5"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 14 }}
                >
                  {(form.category === 'run' ? RUNNING_PR_LABELS : LIFTING_PR_LABELS).map(opt => (
                    <option key={opt.label} value={opt.label}>{opt.label}</option>
                  ))}
                </select>
              </div>

              {/* Value + unit */}
              <div className="flex gap-3">
                <div style={{ flex: 2 }}>
                  <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>
                    {form.category === 'run'
                      ? (form.unit === 'mi' ? 'Distance (miles)' : 'Pace (min per mile, e.g. 8.5 = 8:30)')
                      : (form.unit === 'reps' ? 'Max Reps' : 'Max Weight (lbs)')}
                  </p>
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder={form.unit === 'min/mi' ? 'e.g. 7.5' : form.unit === 'mi' ? 'e.g. 13.1' : 'e.g. 225'}
                    value={form.value}
                    onChange={e => setForm(prev => ({ ...prev, value: e.target.value }))}
                    className="w-full rounded-xl border px-3 py-2.5"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 14 }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Unit</p>
                  <div className="w-full rounded-xl border px-3 py-2.5 text-sm" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)', color: 'var(--text-muted)' }}>
                    {form.unit}
                  </div>
                </div>
              </div>

              {/* Date */}
              <div>
                <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Date Achieved</p>
                <input
                  type="date"
                  value={form.achieved_at}
                  onChange={e => setForm(prev => ({ ...prev, achieved_at: e.target.value }))}
                  className="w-full rounded-xl border px-3 py-2.5"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 14 }}
                />
              </div>

              {/* Notes */}
              <div>
                <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Notes (optional)</p>
                <input
                  placeholder={form.category === 'run' ? 'e.g. Chicago Marathon, felt strong' : 'e.g. competition lift, belt + sleeves'}
                  value={form.notes}
                  onChange={e => setForm(prev => ({ ...prev, notes: e.target.value }))}
                  className="w-full rounded-xl border px-3 py-2.5"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 14 }}
                />
              </div>

              <div className="flex gap-2 pt-1">
                <button type="submit" className="flex-1 rounded-xl px-4 py-3 font-bold text-sm" style={{ background: 'var(--accent)', color: '#000', border: 'none', cursor: 'pointer' }}>Save PR</button>
                <button type="button" onClick={() => setShowModal(false)} className="flex-1 rounded-xl border px-4 py-3 text-sm" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'none', cursor: 'pointer' }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
