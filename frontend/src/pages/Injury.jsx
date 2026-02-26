import { useEffect, useState, useMemo, useRef } from 'react'
import { AlertTriangle, CheckCircle2, Activity } from 'lucide-react'
import api from '../lib/api'
import { getRecurringInjuryWarning, scrollToFirstError, validateInjuryLog } from '../utils/validation'

const BODY_PARTS = ['knee', 'hip', 'ankle', 'shin', 'calf', 'hamstring', 'lower back', 'shoulder', 'other']

function painColor(level) {
  if (level <= 3) return '#22c55e'
  if (level <= 6) return '#EAB308'
  return '#ef4444'
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-')
  return `${m}/${d}/${y}`
}

export default function Injury() {
  const today = new Date().toISOString().slice(0, 10)
  const [active, setActive] = useState([])
  const [history, setHistory] = useState([])
  const [allInjuries, setAllInjuries] = useState([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const bodyPartErrorRef = useRef(null)
  const painErrorRef = useRef(null)

  const [form, setForm] = useState({
    body_part: '',
    pain_level: '',
    notes: '',
    date: today,
  })

  const loadData = async () => {
    try {
      const [activeRes, allRes] = await Promise.all([
        api.get('/injury/active'),
        api.get('/injury'),
      ])
      setActive(activeRes.data.injuries || [])
      const all = allRes.data.injuries || []
      setAllInjuries(all)
      setHistory(all.filter(i => i.cleared === 1))
    } catch (_) {}
    setLoading(false)
  }

  useEffect(() => { loadData() }, [])

  const recurringWarning = useMemo(() => {
    return getRecurringInjuryWarning({ bodyPart: form.body_part, injuries: allInjuries })
  }, [form.body_part, allInjuries])

  const submit = async (e) => {
    e.preventDefault()
    const { errors } = validateInjuryLog({ bodyPart: form.body_part, severity: form.pain_level })
    setFieldErrors(errors)
    if (Object.keys(errors).length) {
      scrollToFirstError({ body_part: bodyPartErrorRef, pain_level: painErrorRef }, ['body_part', 'pain_level'])
      return
    }

    setSubmitting(true)
    try {
      await api.post('/injury', {
        body_part: form.body_part,
        pain_level: Number(form.pain_level),
        notes: form.notes,
        date: form.date,
      })
      setForm({ body_part: '', pain_level: '', notes: '', date: today })
      setFieldErrors({})
      setMessage('Injury logged')
      await loadData()
      setTimeout(() => setMessage(''), 2000)
    } catch (_) {
      setMessage('Failed to log injury')
    }
    setSubmitting(false)
  }

  const markCleared = async (id) => {
    try {
      await api.put(`/injury/${id}/clear`)
      await loadData()
    } catch (_) {}
  }

  const cardStyle = {
    background: 'var(--bg-card)',
    borderRadius: 16,
    padding: 20,
    marginBottom: 12,
    border: '1px solid var(--border-subtle)',
  }

  const sectionLabel = {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-muted)',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 14,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  }

  const inputStyle = {
    background: 'var(--bg-input)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 10,
    padding: '12px 14px',
    fontSize: 14,
    color: 'var(--text-primary)',
    width: '100%',
    boxSizing: 'border-box',
  }

  if (loading) {
    return (
      <div style={{ background: 'var(--bg-card)', borderRadius: 16, padding: 20, color: 'var(--text-muted)' }}>
        Loading...
      </div>
    )
  }

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 900, color: 'var(--text-primary)', marginBottom: 16 }}>
        Injury Log
      </h1>

      {/* Active Injuries */}
      <div style={cardStyle}>
        <div style={sectionLabel}>
          <AlertTriangle size={14} color="#EAB308" />
          Active Injuries
        </div>
        {active.length === 0 ? (
          <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>No active injuries</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {active.map(injury => (
              <div
                key={injury.id}
                style={{
                  background: 'var(--bg-base)',
                  borderRadius: 12,
                  padding: 14,
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'capitalize' }}>
                      {String(injury.body_part || '').replace(/_/g, ' ')}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: '#000',
                        background: painColor(injury.pain_level),
                        borderRadius: 20,
                        padding: '2px 10px',
                      }}
                    >
                      Pain {injury.pain_level}/10
                    </span>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{formatDate(injury.date)}</span>
                </div>
                {injury.notes && (
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.4 }}>
                    {injury.notes}
                  </p>
                )}
                <button
                  onClick={() => markCleared(injury.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    background: 'rgba(34,197,94,0.1)',
                    border: '1px solid rgba(34,197,94,0.3)',
                    borderRadius: 8,
                    padding: '6px 12px',
                    fontSize: 13,
                    fontWeight: 600,
                    color: '#22c55e',
                    cursor: 'pointer',
                  }}
                >
                  <CheckCircle2 size={14} />
                  Mark Cleared
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Log New Injury Form */}
      <div style={cardStyle}>
        <div style={sectionLabel}>
          <AlertTriangle size={14} />
          Log New Injury
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
              Body Part
            </label>
            <select
              value={form.body_part}
              onChange={e => setForm(prev => ({ ...prev, body_part: e.target.value }))}
              style={inputStyle}
            >
              <option value="">Select body part</option>
              {BODY_PARTS.map(part => (
                <option key={part} value={part}>
                  {part.charAt(0).toUpperCase() + part.slice(1)}
                </option>
              ))}
            </select>
            {fieldErrors.body_part && <p ref={bodyPartErrorRef} style={{ fontSize: 12, color: '#ef4444', marginTop: 6 }}>{fieldErrors.body_part}</p>}
            {recurringWarning && <p style={{ fontSize: 12, color: '#f59e0b', marginTop: 6 }}>{recurringWarning}</p>}
          </div>

          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
              Pain Level: <span style={{ fontWeight: 700, color: painColor(Number(form.pain_level) || 1) }}>{Number(form.pain_level) || 1}/10</span>
            </label>
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={form.pain_level || 1}
              onChange={e => setForm(prev => ({ ...prev, pain_level: Number(e.target.value) }))}
              style={{ width: '100%', accentColor: painColor(Number(form.pain_level) || 1) }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
              <span style={{ fontSize: 11, color: '#22c55e' }}>1 Mild</span>
              <span style={{ fontSize: 11, color: '#EAB308' }}>5 Moderate</span>
              <span style={{ fontSize: 11, color: '#ef4444' }}>10 Severe</span>
            </div>
            {fieldErrors.pain_level && <p ref={painErrorRef} style={{ fontSize: 12, color: '#ef4444', marginTop: 6 }}>{fieldErrors.pain_level}</p>}
          </div>

          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
              Date
            </label>
            <input
              type="date"
              value={form.date}
              onChange={e => setForm(prev => ({ ...prev, date: e.target.value }))}
              style={inputStyle}
            />
          </div>

          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
              Notes
            </label>
            <textarea
              rows={3}
              placeholder="Describe the injury, when it started, what aggravates it..."
              value={form.notes}
              onChange={e => setForm(prev => ({ ...prev, notes: e.target.value }))}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>

          {message && (
            <p style={{ fontSize: 13, color: message.startsWith('Failed') ? '#ef4444' : '#22c55e' }}>
              {message}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            style={{
              background: '#EAB308',
              color: '#000',
              border: 'none',
              borderRadius: 10,
              padding: '12px 0',
              fontSize: 15,
              fontWeight: 700,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.7 : 1,
            }}
          >
            {submitting ? 'Logging...' : 'Log Injury'}
          </button>
        </form>
      </div>

      {/* History */}
      <div style={cardStyle}>
        <div style={sectionLabel}>
          <Activity size={14} />
          Injury History
        </div>
        {history.length === 0 ? (
          <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>No injury history yet</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {history.map(injury => (
              <div
                key={injury.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  background: 'var(--bg-base)',
                  borderRadius: 10,
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <CheckCircle2 size={14} color="#22c55e" />
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', textTransform: 'capitalize' }}>
                    {String(injury.body_part || '').replace(/_/g, ' ')}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: '#000',
                      background: painColor(injury.pain_level),
                      borderRadius: 20,
                      padding: '1px 8px',
                    }}
                  >
                    {injury.pain_level}/10
                  </span>
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{formatDate(injury.date)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
