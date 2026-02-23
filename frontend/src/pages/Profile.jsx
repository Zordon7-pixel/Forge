import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Settings as SettingsIcon, User, Dumbbell, HeartPulse, Eye } from 'lucide-react'
import api from '../lib/api'

const personalityOptions = [
  { key: 'mentor', label: 'Mentor', description: 'Guidance and wisdom, no pressure' },
  { key: 'hype_coach', label: 'Hype Coach', description: 'High energy, keeps you fired up' },
  { key: 'drill_sergeant', label: 'Drill Sergeant', description: 'No excuses, maximum output' },
  { key: 'training_partner', label: 'Training Partner', description: 'Supportive, runs with you mentally' }
]

function MetaGlassesCard() {
  const [status, setStatus] = useState(null)
  const [dismissed, setDismissed] = useState(() => localStorage.getItem('meta_glasses_dismissed') === 'true')

  useEffect(() => {
    api.get('/watch-sync/meta/status').then(r => setStatus(r.data)).catch(() => {})
  }, [])

  if (dismissed) return null

  return (
    <div style={{
      background: 'var(--bg-card)', borderRadius: 16, padding: 16,
      border: '1px solid var(--border-subtle)', marginBottom: 12,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(234,179,8,0.1)', border: '1px solid rgba(234,179,8,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Eye size={18} color="#EAB308" />
          </div>
          <div>
            <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Meta Ray-Ban Glasses</p>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0' }}>Smart glasses integration</p>
          </div>
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#EAB308', background: 'rgba(234,179,8,0.1)', padding: '3px 8px', borderRadius: 6, border: '1px solid rgba(234,179,8,0.3)' }}>
          Coming Soon
        </span>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        When Meta opens their API, FORGE will automatically sync: activity detection, step tracking, ambient audio coaching, and POV workout capture.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {['Activity Detection', 'Step Tracking', 'Voice Coaching', 'POV Capture'].map(cap => (
          <span key={cap} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 20, background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>
            {cap}
          </span>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          style={{ flex: 1, padding: '8px 0', borderRadius: 10, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontSize: 13, fontWeight: 600, cursor: 'not-allowed', opacity: 0.6 }}
          disabled
        >
          Connect Meta Account
        </button>
        <button
          onClick={() => { localStorage.setItem('meta_glasses_dismissed', 'true'); setDismissed(true) }}
          style={{ padding: '8px 12px', borderRadius: 10, background: 'none', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}

export default function Profile() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    name: '', email: '', age: '', weight_lbs: '', sex: 'male', fitness_level: 'beginner', primary_goal: 'general_fitness', injury_status: 'none', injury_detail: '', coach_personality: 'mentor', weekly_miles: ''
  })
  const [profileStats, setProfileStats] = useState(null)
  const [injuryMode, setInjuryMode] = useState(false)
  const [injuryDescription, setInjuryDescription] = useState('')
  const [injuryLimitations, setInjuryLimitations] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        const [res, statsRes] = await Promise.all([
          api.get('/auth/me'),
          api.get('/auth/me/stats').catch(() => null)
        ])
        const user = res.data?.user || res.data || {}
        setForm({
          name: user.name || '',
          email: user.email || '',
          age: user.age ?? '',
          weight_lbs: user.weight_lbs ?? '',
          sex: user.sex || 'male',
          fitness_level: user.fitness_level || (user.comeback_mode ? 'intermediate' : 'beginner'),
          primary_goal: user.primary_goal || user.goal_type || 'general_fitness',
          injury_status: user.injury_status || (user.injury_notes ? 'recovering' : 'none'),
          injury_detail: user.injury_detail || user.injury_notes || '',
          coach_personality: user.coach_personality || 'mentor',
          weekly_miles: user.weekly_miles ?? user.weekly_miles_current ?? ''
        })
        setProfileStats(statsRes?.data || null)
        setInjuryMode(!!user.injury_mode)
        setInjuryDescription(user.injury_description || '')
        setInjuryLimitations(user.injury_limitations || '')
      } finally { setLoading(false) }
    })()
  }, [])

  const update = (key, value) => setForm(prev => ({ ...prev, [key]: value }))

  const save = async e => {
    e.preventDefault(); setError(''); setSaving(true); setSaved(false)
    try {
      await api.put('/auth/me/profile', {
        name: form.name,
        age: form.age === '' ? null : Number(form.age),
        weight_lbs: form.weight_lbs === '' ? null : Number(form.weight_lbs),
        sex: form.sex,
        fitness_level: form.fitness_level,
        primary_goal: form.primary_goal,
        injury_status: form.injury_status,
        injury_detail: form.injury_detail,
        coach_personality: form.coach_personality,
        weekly_miles: form.weekly_miles === '' ? null : Number(form.weekly_miles),
        weekly_miles_current: form.weekly_miles === '' ? null : Number(form.weekly_miles),
        goal_type: form.primary_goal,
        injury_notes: form.injury_detail,
        comeback_mode: form.injury_status !== 'none' ? 1 : 0
      })
      await api.post('/auth/injury', {
        injury_mode: injuryMode,
        injury_description: injuryDescription,
        injury_date: injuryMode ? new Date().toISOString().slice(0, 10) : '',
        injury_limitations: injuryLimitations,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 1800)
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not save profile changes.')
    } finally { setSaving(false) }
  }

  const logout = () => {
    localStorage.removeItem('forge_token')
    navigate('/login')
  }

  if (loading) return <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>Loading profile...</div>

  const sectionStyle = { background: 'var(--bg-card)', borderRadius: 16, padding: 20, marginBottom: 12 }
  const sectionLabel = { fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 14 }
  const inputStyle = { background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '12px 14px', fontSize: 14, color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' }
  const pillActive = { background: 'var(--accent)', color: '#000', border: 'none', borderRadius: 20, padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }
  const pillInactive = { background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', borderRadius: 20, padding: '8px 16px', fontSize: 13, fontWeight: 400, cursor: 'pointer' }

  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
      <h2 className="mb-4 text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Profile</h2>

          <div style={{ background: 'var(--bg-card)', borderRadius: 20, padding: 24, marginBottom: 16, textAlign: 'center', border: '1px solid var(--border-subtle)' }}>
            <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'var(--bg-base)', border: '3px solid var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', fontSize: 28, fontWeight: 900, color: 'var(--accent)' }}>
              {(form.name || 'U')[0].toUpperCase()}
            </div>
            <p style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 2 }}>{form.name || 'Athlete'}</p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>{form.email}</p>
            {profileStats && (
              <div style={{ display: 'flex', justifyContent: 'center', gap: 24, marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
                {[
                  { label: 'Total Runs', value: profileStats.all?.runs ?? 0 },
                  { label: 'Total Miles', value: (profileStats.all?.miles ?? 0).toFixed(1) },
                  { label: 'This Week', value: `${(profileStats.week?.miles ?? 0).toFixed(1)} mi` }
                ].map(s => (
                  <div key={s.label} style={{ textAlign: 'center' }}>
                    <p style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)' }}>{s.value}</p>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.label}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <form onSubmit={save}>
            <div style={sectionStyle}>
              <div style={{ ...sectionLabel, display: 'flex', alignItems: 'center', gap: 8 }}><User size={14} /> Identity</div>
              <div style={{ marginBottom: 12 }}>
                <input type="text" placeholder="Full name" value={form.name} onChange={e => update('name', e.target.value)} style={inputStyle} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <input type="email" value={form.email} readOnly style={{ ...inputStyle, color: 'var(--text-muted)' }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                <input type="number" min="0" placeholder="Age" value={form.age} onChange={e => update('age', e.target.value)} style={inputStyle} />
                <input type="number" min="0" step="0.1" placeholder="Weight (lbs)" value={form.weight_lbs} onChange={e => update('weight_lbs', e.target.value)} style={inputStyle} />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {['male', 'female'].map(s => (
                  <button key={s} type="button" onClick={() => update('sex', s)} style={form.sex === s ? { ...pillActive, flex: 1 } : { ...pillInactive, flex: 1 }}>
                    {s === 'male' ? 'Male' : 'Female'}
                  </button>
                ))}
              </div>
            </div>

            <div style={sectionStyle}>
              <div style={{ ...sectionLabel, display: 'flex', alignItems: 'center', gap: 8 }}><Dumbbell size={14} /> Training</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 8, marginBottom: 12 }}>
                {[
                  { key: 'beginner', label: 'Beginner' },
                  { key: 'intermediate', label: 'Intermediate' },
                  { key: 'advanced', label: 'Advanced' }
                ].map(level => (
                  <button key={level.key} type="button" onClick={() => update('fitness_level', level.key)} style={form.fitness_level === level.key ? pillActive : pillInactive}>
                    {level.label}
                  </button>
                ))}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                {[
                  { key: 'get_faster', label: 'Get Faster' },
                  { key: 'run_longer', label: 'Run Longer' },
                  { key: 'lose_fat', label: 'Lose Fat' },
                  { key: 'general_fitness', label: 'General Fitness' }
                ].map(goal => (
                  <button key={goal.key} type="button" onClick={() => update('primary_goal', goal.key)} style={form.primary_goal === goal.key ? pillActive : pillInactive}>
                    {goal.label}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="number" min="0" step="0.1" placeholder="0.0" value={form.weekly_miles} onChange={e => update('weekly_miles', e.target.value)} style={inputStyle} />
                <span style={{ color: 'var(--text-muted)', fontSize: 13, whiteSpace: 'nowrap' }}>miles/week</span>
              </div>
            </div>

            <div style={sectionStyle}>
              <div style={{ ...sectionLabel, display: 'flex', alignItems: 'center', gap: 8 }}><HeartPulse size={14} /> Your Coach</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {personalityOptions.map(option => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => update('coach_personality', option.key)}
                    style={form.coach_personality === option.key
                      ? {
                        textAlign: 'left',
                        background: 'var(--accent-dim)',
                        border: '1px solid var(--accent)',
                        borderRadius: 12,
                        padding: 12,
                        color: 'var(--text-primary)'
                      }
                      : {
                        textAlign: 'left',
                        background: 'var(--bg-input)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 12,
                        padding: 12,
                        color: 'var(--text-muted)'
                      }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3, color: form.coach_personality === option.key ? 'var(--text-primary)' : 'var(--text-primary)' }}>{option.label}</div>
                    <div style={{ fontSize: 12, lineHeight: 1.3 }}>{option.description}</div>
                  </button>
                ))}
              </div>
            </div>

            <div
              style={{
                ...sectionStyle,
                border: injuryMode ? '1px solid var(--accent)' : '1px solid var(--border-subtle)',
                background: injuryMode ? 'var(--accent-dim)' : 'var(--bg-card)'
              }}
            >
              <div style={{ ...sectionLabel, marginBottom: 10 }}>Injury Mode</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: injuryMode ? 12 : 0, gap: 10 }}>
                <div>
                  <p style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>{injuryMode ? 'Recovery Plan Enabled' : 'Off'}</p>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Adjust training around injuries and current limitations.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setInjuryMode(!injuryMode)}
                  style={injuryMode ? { ...pillActive, whiteSpace: 'nowrap' } : { ...pillInactive, whiteSpace: 'nowrap' }}
                >
                  {injuryMode ? 'ON' : 'OFF'}
                </button>
              </div>

              {injuryMode && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input value={injuryDescription} onChange={e => setInjuryDescription(e.target.value)} placeholder="What is injured?" style={inputStyle} />
                  <input value={injuryLimitations} onChange={e => setInjuryLimitations(e.target.value)} placeholder="Current limitations" style={inputStyle} />
                </div>
              )}
            </div>

            <div style={sectionStyle}>
              <div style={sectionLabel}>Injury Details</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 8, marginBottom: 10 }}>
                {['none', 'recovering', 'chronic'].map(status => (
                  <button key={status} type="button" onClick={() => update('injury_status', status)} style={form.injury_status === status ? pillActive : pillInactive}>
                    {status.charAt(0).toUpperCase() + status.slice(1)}
                  </button>
                ))}
              </div>
              {form.injury_status !== 'none' && (
                <textarea rows={3} placeholder="Injury details" value={form.injury_detail} onChange={e => update('injury_detail', e.target.value)} style={{ ...inputStyle, resize: 'vertical' }} />
              )}
            </div>

            {error && <p className="text-sm" style={{ color: 'var(--accent)' }}>{error}</p>}
            {saved && <p className="text-sm" style={{ color: 'var(--text-primary)' }}>Saved</p>}

            <button type="submit" disabled={saving} className="w-full rounded-xl py-3 font-semibold disabled:opacity-70" style={{ background: 'var(--accent)', color: '#000', marginTop: 8 }}>{saving ? 'Saving...' : 'Save Changes'}</button>
          </form>

          <div
            onClick={() => navigate('/settings')}
            className="flex items-center justify-between rounded-xl p-4 cursor-pointer transition-colors mt-4"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
          >
            <div className="flex items-center gap-3">
              <SettingsIcon size={18} className="text-[var(--accent)]" />
              <span className="text-sm font-medium text-[var(--text-primary)]">Settings</span>
            </div>
            <ChevronRight size={16} className="text-[var(--text-muted)]" />
          </div>

          <div onClick={() => navigate('/journal')} className="flex items-center justify-between rounded-xl p-4 cursor-pointer transition-colors mt-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <span className="text-sm font-medium text-[var(--text-primary)]">Journal</span>
            <ChevronRight size={16} className="text-[var(--text-muted)]" />
          </div>

          <div style={{ marginTop: 16 }}>
            <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Connected Devices</p>
            <MetaGlassesCard />
          </div>

          <button type="button" onClick={logout} className="w-full bg-transparent py-3 font-medium mt-2" style={{ color: 'var(--text-muted)', border: 'none' }}>Log Out</button>
    </div>
  )
}
