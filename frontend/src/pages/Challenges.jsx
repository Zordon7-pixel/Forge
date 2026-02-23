import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Footprints, ChevronDown, ChevronUp } from 'lucide-react'
import api from '../lib/api'
import PRWall from './PRWall'
import Badges from './Badges'

function fmtValue(value, unit) {
  if (unit === 'miles') return `${Number(value).toFixed(value % 1 === 0 ? 0 : 1)} miles`
  if (unit === 'steps') return `${Math.round(value).toLocaleString()} steps`
  return `${Math.round(value)} days`
}

export default function Challenges() {
  const [activeTab, setActiveTab] = useState('challenges')
  const [loading, setLoading] = useState(true)
  const [challenges, setChallenges] = useState([])
  const [myChallenges, setMyChallenges] = useState([])
  const [today, setToday] = useState({ steps: 0, goal: 10000, date: '' })
  const [week, setWeek] = useState({ days: [], weekTotal: 0, goal: 10000 })
  const [showStepInput, setShowStepInput] = useState(false)
  const [stepInput, setStepInput] = useState('')
  const [expandedId, setExpandedId] = useState(null)
  const [showBrowse, setShowBrowse] = useState(true)
  const [feed, setFeed] = useState([])
  const [feedLastUpdated, setFeedLastUpdated] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({ name: '', type: 'running', target_value: '', description: '' })
  const [creating, setCreating] = useState(false)

  const CHALLENGE_TEMPLATES = [
    { type: 'running',    label: 'Running',        unit: 'miles',   placeholder: 'e.g. 50',   hint: 'Total miles to run' },
    { type: 'walking',    label: 'Walking',         unit: 'miles',   placeholder: 'e.g. 30',   hint: 'Total miles to walk' },
    { type: 'steps',      label: 'Steps',           unit: 'steps',   placeholder: 'e.g. 100000', hint: 'Total steps to hit' },
    { type: 'gym_time',   label: 'Gym Time',        unit: 'minutes', placeholder: 'e.g. 600',  hint: 'Total minutes in the gym' },
    { type: 'streak',     label: 'Workout Streak',  unit: 'days',    placeholder: 'e.g. 30',   hint: 'Consecutive active days' },
    { type: 'elevation',  label: 'Elevation Climb', unit: 'feet',    placeholder: 'e.g. 10000', hint: 'Total feet of elevation gain' },
    { type: 'workouts',   label: 'Most Workouts',   unit: 'sessions', placeholder: 'e.g. 20', hint: 'Total workout sessions' },
    { type: 'custom',     label: 'Custom',          unit: 'units',   placeholder: 'e.g. 100',  hint: 'Your own challenge metric' },
  ]

  async function submitCreate() {
    const tmpl = CHALLENGE_TEMPLATES.find(t => t.type === createForm.type)
    if (!createForm.name.trim() || !createForm.target_value) return
    setCreating(true)
    try {
      await api.post('/challenges/create', {
        name: createForm.name,
        description: createForm.description,
        type: createForm.type,
        target_value: Number(createForm.target_value),
        unit: tmpl?.unit || 'units',
      })
      setShowCreate(false)
      setCreateForm({ name: '', type: 'running', target_value: '', description: '' })
      await loadData()
    } finally { setCreating(false) }
  }

  async function loadData() {
    setLoading(true)
    try {
      const [allRes, myRes, todayRes, weekRes, feedRes] = await Promise.all([
        api.get('/challenges'),
        api.get('/challenges/my'),
        api.get('/challenges/steps/today'),
        api.get('/challenges/steps/week'),
        api.get('/challenges/feed'),
      ])
      setChallenges(allRes.data?.challenges || [])
      setMyChallenges(myRes.data?.challenges || [])
      setToday(todayRes.data || { steps: 0, goal: 10000, date: '' })
      setWeek(weekRes.data || { days: [], weekTotal: 0, goal: 10000 })
      setFeed(feedRes.data?.feed || [])
      setFeedLastUpdated(new Date())
    } finally {
      setLoading(false)
    }
  }

  async function refreshFeed() {
    try {
      const res = await api.get('/challenges/feed')
      setFeed(res.data?.feed || [])
      setFeedLastUpdated(new Date())
    } catch {}
  }

  useEffect(() => {
    loadData()
    const interval = setInterval(refreshFeed, 24 * 60 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  const featured = useMemo(() => challenges.filter(c => c.is_featured), [challenges])
  const unjoined = useMemo(() => challenges.filter(c => !c.joined), [challenges])

  async function joinChallenge(id) {
    await api.post(`/challenges/${id}/join`, {})
    await api.post('/challenges/sync', {})
    await loadData()
  }

  async function logSteps() {
    const steps = Number(stepInput)
    if (!Number.isFinite(steps) || steps < 0) return
    await api.post('/challenges/steps', { steps })
    await api.post('/challenges/sync', {})
    setStepInput('')
    setShowStepInput(false)
    await loadData()
  }

  function renderChallengesTab() {
    if (loading) {
      return (
        <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>
          Loading challenges...
        </div>
      )
    }

    return (
      <div className="space-y-5">
        <section>
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
            Featured Courses
          </h3>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {featured.map(c => {
              const pct = Math.min(100, (Number(c.progress || 0) / Number(c.target_value || 1)) * 100)
              return (
                <div
                  key={c.id}
                  className="group relative flex-shrink-0 rounded-xl p-3"
                  style={{
                    width: 100,
                    minHeight: 112,
                    border: `2px solid ${c.badge_color || 'var(--accent)'}`,
                    background: 'var(--bg-card)',
                  }}
                >
                  <div className="flex items-center justify-center rounded-xl" style={{ height: 56, background: 'var(--bg-input)' }}>
                    <span className="text-lg font-black" style={{ color: c.badge_color || 'var(--accent)' }}>
                      {c.unit === 'miles' ? Number(c.target_value).toFixed(c.target_value % 1 === 0 ? 0 : 1) : Math.round(c.target_value / 1000)}
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] font-bold leading-tight" style={{ color: 'var(--text-primary)' }}>{c.name}</p>
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{fmtValue(c.target_value, c.unit)}</p>
                  {c.joined ? (
                    <p className="mt-1 text-[10px] font-semibold" style={{ color: 'var(--accent)' }}>{Math.round(pct)}% complete</p>
                  ) : (
                    <button
                      onClick={() => joinChallenge(c.id)}
                      className="absolute inset-x-2 bottom-2 rounded-lg px-2 py-1 text-[10px] font-bold opacity-100 transition group-hover:opacity-100"
                      style={{ background: 'var(--accent)', color: '#000' }}
                    >
                      Join
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </section>

        <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <div className="mb-3 flex items-center gap-2">
            <Footprints size={16} style={{ color: 'var(--accent)' }} />
            <h3 className="text-sm font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Steps This Week</h3>
          </div>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Today</p>
          <p className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>{Number(today.steps || 0).toLocaleString()} steps</p>
          <p className="mb-3 text-xs" style={{ color: 'var(--text-muted)' }}>Goal: {Number(today.goal || 10000).toLocaleString()}</p>

          <div className="mb-3 flex items-end gap-2">
            {(week.days || []).map(d => {
              const ratio = Math.min(1, (d.steps || 0) / (d.goal || week.goal || 10000))
              const height = Math.max(8, Math.round(ratio * 60))
              const hitGoal = (d.steps || 0) >= (d.goal || week.goal || 10000)
              return (
                <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
                  <div
                    className="w-full rounded-md"
                    style={{
                      height,
                      background: hitGoal ? '#22c55e' : '#EAB308',
                      minWidth: 10,
                    }}
                    title={`${d.date}: ${d.steps}`}
                  />
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{d.date.slice(5)}</span>
                </div>
              )
            })}
          </div>

          {!showStepInput ? (
            <button className="rounded-xl px-3 py-2 text-xs font-bold" style={{ background: 'var(--accent)', color: '#000' }} onClick={() => setShowStepInput(true)}>
              Log today's steps
            </button>
          ) : (
            <div className="flex items-center gap-2 rounded-xl p-2" style={{ background: 'var(--bg-input)' }}>
              <input
                type="number"
                placeholder="Steps today"
                value={stepInput}
                onChange={e => setStepInput(e.target.value)}
                className="flex-1 rounded-lg px-3 py-2 text-sm"
                style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
              />
              <button className="rounded-lg px-3 py-2 text-xs font-bold" style={{ background: 'var(--accent)', color: '#000' }} onClick={logSteps}>
                Save
              </button>
            </div>
          )}

          <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>Connect Garmin to sync automatically</p>
        </section>

        <section>
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
            My Challenges
          </h3>
          <div className="space-y-2">
            {myChallenges.length === 0 && (
              <div className="rounded-xl p-3 text-sm" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>
                Join a challenge to start tracking progress.
              </div>
            )}
            {myChallenges.map(c => {
              const pct = Math.min(100, (Number(c.progress || 0) / Number(c.target_value || 1)) * 100)
              const complete = !!c.completed_at || pct >= 100
              const isOpen = expandedId === c.id
              return (
                <button
                  key={c.id}
                  onClick={() => setExpandedId(isOpen ? null : c.id)}
                  className="w-full rounded-xl p-3 text-left"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{c.name}</p>
                    {complete && (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: '#22c55e' }}>
                        <CheckCircle2 size={14} />
                        {c.completed_at ? new Date(c.completed_at).toLocaleDateString() : 'Completed'}
                      </span>
                    )}
                  </div>
                  <div className="h-2 w-full rounded-full" style={{ background: 'var(--bg-input)' }}>
                    <div className="h-2 rounded-full" style={{ width: `${pct}%`, background: 'var(--accent)' }} />
                  </div>
                  <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {fmtValue(c.progress || 0, c.unit)} of {fmtValue(c.target_value, c.unit)} • {Math.round(pct)}% complete
                  </p>
                  {isOpen && (
                    <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{c.description}</p>
                  )}
                </button>
              )
            })}
          </div>
        </section>

        <section className="rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <button
            onClick={() => setShowBrowse(v => !v)}
            className="flex w-full items-center justify-between p-3"
            style={{ color: 'var(--text-primary)' }}
          >
            <span className="text-sm font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Browse All</span>
            {showBrowse ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {showBrowse && (
            <div className="space-y-2 px-3 pb-3">
              {unjoined.map(c => (
                <div key={c.id} className="rounded-lg p-3" style={{ background: 'var(--bg-input)' }}>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{c.name}</p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{fmtValue(c.target_value, c.unit)}</p>
                    </div>
                    <button onClick={() => joinChallenge(c.id)} className="rounded-lg px-3 py-1.5 text-xs font-bold" style={{ background: 'var(--accent)', color: '#000' }}>
                      Join
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Create Challenge */}
        <section style={{ borderRadius: 14, border: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
          <button
            onClick={() => setShowCreate(v => !v)}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--bg-card)', border: 'none', cursor: 'pointer' }}
          >
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Create a Challenge</span>
            {showCreate ? <ChevronUp size={16} color="var(--text-muted)" /> : <ChevronDown size={16} color="var(--text-muted)" />}
          </button>

          {showCreate && (
            <div style={{ background: 'var(--bg-card)', padding: '0 16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>Challenge Type</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {CHALLENGE_TEMPLATES.map(t => (
                    <button key={t.type} onClick={() => setCreateForm(f => ({ ...f, type: t.type, name: f.name || t.label + ' Challenge' }))}
                      style={{ padding: '7px 14px', borderRadius: 20, fontSize: 12, fontWeight: 700, border: 'none', cursor: 'pointer',
                        background: createForm.type === t.type ? 'var(--accent)' : 'var(--bg-input)',
                        color: createForm.type === t.type ? '#000' : 'var(--text-muted)' }}>
                      {t.label}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                  {CHALLENGE_TEMPLATES.find(t => t.type === createForm.type)?.hint}
                </p>
              </div>
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>Challenge Name</p>
                <input value={createForm.name} onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))} placeholder="Name your challenge"
                  style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '10px 12px', fontSize: 14, color: 'var(--text-primary)', boxSizing: 'border-box' }} />
              </div>
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>
                  Target ({CHALLENGE_TEMPLATES.find(t => t.type === createForm.type)?.unit})
                </p>
                <input type="number" value={createForm.target_value} onChange={e => setCreateForm(f => ({ ...f, target_value: e.target.value }))}
                  placeholder={CHALLENGE_TEMPLATES.find(t => t.type === createForm.type)?.placeholder}
                  style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '10px 12px', fontSize: 14, color: 'var(--text-primary)', boxSizing: 'border-box' }} />
              </div>
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>Description (optional)</p>
                <textarea rows={2} value={createForm.description} onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))} placeholder="What's this challenge about?"
                  style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '10px 12px', fontSize: 14, color: 'var(--text-primary)', boxSizing: 'border-box', resize: 'none' }} />
              </div>
              <button onClick={submitCreate} disabled={creating || !createForm.name.trim() || !createForm.target_value}
                style={{ width: '100%', background: 'var(--accent)', color: '#000', fontWeight: 900, borderRadius: 12, padding: '14px', border: 'none', cursor: 'pointer', fontSize: 15, opacity: creating ? 0.6 : 1 }}>
                {creating ? 'Creating...' : 'Create Challenge'}
              </button>
            </div>
          )}
        </section>
      </div>
    )
  }

  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {['challenges', 'prs', 'badges', 'feed'].map(t => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            style={{
              padding: '8px 14px', borderRadius: 20, fontSize: 13, fontWeight: 700, border: 'none', cursor: 'pointer',
              background: activeTab === t ? 'var(--accent)' : 'var(--bg-card)',
              color: activeTab === t ? '#000' : 'var(--text-muted)',
            }}
          >
            {t === 'challenges' ? 'Challenges' : t === 'prs' ? 'PRs' : t === 'badges' ? 'Badges' : 'Feed'}
          </button>
        ))}
      </div>

      {activeTab === 'challenges' && renderChallengesTab()}
      {activeTab === 'prs' && <PRWall />}
      {activeTab === 'badges' && <Badges />}
      {activeTab === 'feed' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase' }}>Community Activity</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {feedLastUpdated && (
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  Updated {feedLastUpdated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </span>
              )}
              <button onClick={refreshFeed} style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-dim)', border: 'none', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>
                Refresh
              </button>
            </div>
          </div>

          {feed.length === 0 && (
            <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 14 }}>
              No activity yet. Log a run or workout to show up here.
            </div>
          )}

          {feed.map(item => (
            <div key={item.id} style={{ background: 'var(--bg-base)', borderRadius: 10, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* Avatar */}
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 11, color: '#000', flexShrink: 0 }}>
                {(item.user_name || 'A')[0].toUpperCase()}
              </div>

              {/* Main content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.user_name || 'Athlete'}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                    {item._type === 'run'
                      ? `ran ${item.distance_miles ? Number(item.distance_miles).toFixed(1) + ' mi' : ''}${item.duration_seconds > 0 ? ' · ' + (Math.floor(item.duration_seconds/60)) + 'min' : ''}`
                      : `logged ${item.set_count || 0} sets`}
                  </span>
                </div>
                {item.notes && (
                  <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.notes}</p>
                )}
              </div>

              {/* Type badge + time */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0, gap: 2 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-dim)', padding: '2px 6px', borderRadius: 5, textTransform: 'uppercase' }}>
                  {item._type === 'run' ? (item.surface || 'Run') : 'Lift'}
                </span>
                <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                  {new Date(item._ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
