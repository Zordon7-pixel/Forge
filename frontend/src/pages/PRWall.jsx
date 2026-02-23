import { useEffect, useMemo, useState } from 'react'
import api from '../lib/api'

const baseCardStyle = {
  background: 'var(--bg-card)',
  borderRadius: 16,
  padding: '16px',
  border: '1px solid var(--border-subtle)'
}

const liftingLabels = ['Best Bench Press', 'Best Squat', 'Best Deadlift']

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

export default function PRWall() {
  const [prs, setPrs] = useState([])
  const [totalMiles, setTotalMiles] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState({
    category: 'run',
    label: '',
    value: '',
    unit: 'mi',
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

      const [prsRes, allRunsRes] = await Promise.all([
        api.get('/prs'),
        api.get('/runs')
      ])

      const prList = prsRes.data?.prs || []
      const allRuns = allRunsRes.data?.runs || []
      const miles = allRuns.reduce((sum, run) => sum + (Number(run.distance_miles) || 0), 0)

      setPrs(prList)
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
        <p style={{ color: 'var(--text-muted)' }}>Loading your records...</p>
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

          <section>
            <h2 className="mb-3 text-lg font-bold">Lifting PRs</h2>
            <div className="grid grid-cols-1 gap-3">
              {liftingLabels.map(label => {
                const pr = liftingPRs.find(item => item.label === label)
                if (!pr) {
                  return (
                    <div key={label} style={baseCardStyle}>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</p>
                      <p style={{ color: 'var(--text-muted)' }}>Add this PR manually.</p>
                    </div>
                  )
                }
                return (
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-2xl border p-5" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' }}>
            <h3 className="text-xl font-black">Add Personal Record</h3>
            <form className="mt-4 space-y-3" onSubmit={submitPR}>
              <select
                value={form.category}
                onChange={e => setForm(prev => ({ ...prev, category: e.target.value }))}
                className="w-full rounded-xl border px-3 py-2"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
              >
                <option value="run">Running</option>
                <option value="lift">Lifting</option>
              </select>
              <input
                required
                placeholder="Label (e.g. 5K PR, Bench Press Max)"
                value={form.label}
                onChange={e => setForm(prev => ({ ...prev, label: e.target.value }))}
                className="w-full rounded-xl border px-3 py-2"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
              />
              <input
                required
                type="number"
                step="0.01"
                placeholder="Value"
                value={form.value}
                onChange={e => setForm(prev => ({ ...prev, value: e.target.value }))}
                className="w-full rounded-xl border px-3 py-2"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
              />
              <input
                required
                placeholder="Unit (mi, lbs, reps, min/mi)"
                value={form.unit}
                onChange={e => setForm(prev => ({ ...prev, unit: e.target.value }))}
                className="w-full rounded-xl border px-3 py-2"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
              />
              <input
                type="date"
                value={form.achieved_at}
                onChange={e => setForm(prev => ({ ...prev, achieved_at: e.target.value }))}
                className="w-full rounded-xl border px-3 py-2"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
              />
              <input
                placeholder="Notes (optional)"
                value={form.notes}
                onChange={e => setForm(prev => ({ ...prev, notes: e.target.value }))}
                className="w-full rounded-xl border px-3 py-2"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
              />
              <div className="mt-2 flex gap-2">
                <button type="submit" className="flex-1 rounded-xl px-4 py-2 font-bold" style={{ background: 'var(--accent)', color: '#000' }}>Save PR</button>
                <button type="button" onClick={() => setShowModal(false)} className="flex-1 rounded-xl border px-4 py-2" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
