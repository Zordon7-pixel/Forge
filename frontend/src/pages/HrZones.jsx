import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, ChevronDown, ChevronRight, Gauge, HeartPulse, Save, Sparkles } from 'lucide-react'
import api from '../lib/api'
import LoadingRunner from '../components/LoadingRunner'
import { formatFreshness, hrZoneSourcePresentation } from '../lib/deviceSourcePresentation'

const ZONE_COLORS = ['var(--success)', '#84CC16', 'var(--accent)', 'var(--warning)', 'var(--danger)']
const MODEL_LABELS = {
  hrr: 'HR Reserve',
  maxhr: 'Max-HR %',
  lthr: 'LTHR',
  custom: 'Watch zones',
}

const cardStyle = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 16,
  padding: 16,
}

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  borderRadius: 10,
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
  fontSize: 14,
}

const readError = (err, fallback) => err?.response?.data?.error || fallback
const numberOrNull = (value) => {
  if (value === '' || value === null || value === undefined) return null
  const next = Number(value)
  return Number.isFinite(next) ? next : null
}

function formatRange(zone) {
  if (!zone) return '--'
  const min = zone.minBpm ?? zone.min_bpm
  const max = zone.maxBpm ?? zone.max_bpm
  if (min == null && max == null) return '--'
  if (zone.openEnded) return `${min}+`
  if (max == null) return `${min}+`
  return `${min}-${max}`
}

function ZoneBars({ zones }) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {zones.map((zone, index) => {
        const color = ZONE_COLORS[index] || 'var(--accent)'
        return (
          <div key={zone.zone || index}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ color, fontSize: 12, fontWeight: 900 }}>Z{zone.zone || index + 1}</span>
                <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{zone.label || 'Zone'}</span>
              </div>
              <span style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 800 }}>{formatRange(zone)} bpm</span>
            </div>
            <div style={{ height: 10, borderRadius: 999, background: 'var(--bg-input)', overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
              <div style={{ width: `${60 + index * 10}%`, height: '100%', borderRadius: 999, background: color }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StatChip({ label, value }) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, minWidth: 82, padding: '8px 10px', borderRadius: 12, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 900 }}>{value ?? '--'}</span>
    </span>
  )
}

function SectionToggle({ open, onClick, icon: Icon, title, sub }) {
  return (
    <button type="button" onClick={onClick} style={{ width: '100%', display: 'grid', gridTemplateColumns: '34px minmax(0, 1fr) 20px', alignItems: 'center', gap: 10, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, background: 'var(--accent-dim)', display: 'grid', placeItems: 'center', color: 'var(--accent)' }}><Icon size={18} /></span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', color: 'var(--text-primary)', fontSize: 15, fontWeight: 900 }}>{title}</span>
        <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>{sub}</span>
      </span>
      {open ? <ChevronDown size={18} color="var(--text-muted)" /> : <ChevronRight size={18} color="var(--text-muted)" />}
    </button>
  )
}

export default function HrZones() {
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [suggestion, setSuggestion] = useState(null)
  const [suggestError, setSuggestError] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [applying, setApplying] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [fieldOpen, setFieldOpen] = useState(false)
  const [manualError, setManualError] = useState('')
  const [fieldError, setFieldError] = useState('')
  const [savingManual, setSavingManual] = useState(false)
  const [savingField, setSavingField] = useState(false)
  const [form, setForm] = useState({ maxHr: '', restingHr: '', lthr: '', zoneModel: 'hrr', customMinimums: ['', '', '', '', ''] })
  const [fieldForm, setFieldForm] = useState({ avgHr: '', durationMinutes: 20 })

  const syncForm = (data) => {
    const customMinimums = Array.isArray(data?.customMinimums) && data.customMinimums.length === 5
      ? data.customMinimums.map(String)
      : ['', '', '', '', '']
    setForm({
      maxHr: data?.maxHr ?? '',
      restingHr: data?.restingHr ?? '',
      lthr: data?.lthr ?? '',
      zoneModel: data?.zoneModel || 'hrr',
      customMinimums,
    })
  }

  const load = async () => {
    setLoading(true)
    setLoadError('')
    try {
      const res = await api.get('/profile/hr-zones')
      const next = { ...(res.data?.profile || {}), zones: Array.isArray(res.data?.zones) ? res.data.zones : [] }
      setProfile(next)
      syncForm(next)
    } catch (err) {
      setLoadError(readError(err, 'Unable to load HR zones.'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const derive = async () => {
    setSuggesting(true)
    setSuggestError('')
    try {
      const res = await api.post('/profile/hr-zones/derive')
      setSuggestion(res.data || {})
    } catch (err) {
      setSuggestError(readError(err, 'Unable to suggest zones from your data.'))
    } finally {
      setSuggesting(false)
    }
  }

  const applySuggestion = async () => {
    if (!suggestion?.available) return
    setApplying(true)
    setSuggestError('')
    try {
      await api.put('/profile/hr-zones', {
        maxHr: suggestion.suggestedMaxHr,
        restingHr: suggestion.suggestedRestingHr,
        lthr: null,
        zoneModel: 'hrr',
        customMinimums: [],
      })
      setSuggestion(null)
      await load()
    } catch (err) {
      setSuggestError(readError(err, 'Unable to apply suggested zones.'))
    } finally {
      setApplying(false)
    }
  }

  const saveManual = async () => {
    setSavingManual(true)
    setManualError('')
    try {
      await api.put('/profile/hr-zones', {
        maxHr: numberOrNull(form.maxHr),
        restingHr: numberOrNull(form.restingHr),
        lthr: numberOrNull(form.lthr),
        zoneModel: form.zoneModel,
        customMinimums: form.customMinimums.map(numberOrNull),
      })
      await load()
    } catch (err) {
      setManualError(readError(err, 'Unable to save HR zones.'))
    } finally {
      setSavingManual(false)
    }
  }

  const saveFieldTest = async () => {
    setSavingField(true)
    setFieldError('')
    try {
      await api.post('/profile/hr-zones/field-test', {
        avgHr: numberOrNull(fieldForm.avgHr),
        durationMinutes: numberOrNull(fieldForm.durationMinutes),
      })
      setFieldForm({ avgHr: '', durationMinutes: 20 })
      await load()
    } catch (err) {
      setFieldError(readError(err, 'Unable to save field test.'))
    } finally {
      setSavingField(false)
    }
  }

  if (loading) return <LoadingRunner message="Loading HR zones" />

  const zones = Array.isArray(profile?.zones) ? profile.zones : []
  const hasZones = zones.length > 0
  const zoneSource = hrZoneSourcePresentation(profile || {})
  const zoneFreshness = formatFreshness(profile?.updatedAt, { prefix: 'Updated' })

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <header style={{ marginBottom: 4 }}>
        <p style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>Forged Hybrid</p>
        <h1 style={{ color: 'var(--text-primary)', fontSize: 28, fontWeight: 900, margin: 0 }}>HR Zones</h1>
      </header>

      {loadError && (
        <div style={{ ...cardStyle, borderColor: 'var(--danger-dim)', background: 'var(--danger-dim)', color: 'var(--danger)', fontSize: 13, fontWeight: 800 }}>
          {loadError}
        </div>
      )}

      <section style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
          <div>
            <p style={{ color: 'var(--text-primary)', fontSize: 17, fontWeight: 900, margin: 0 }}>Current zones</p>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '3px 0 0' }}>{hasZones ? 'Live training targets from your profile' : 'Calibrate your zones'}</p>
          </div>
          <HeartPulse size={22} color="var(--danger)" />
        </div>

        {hasZones ? (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              <StatChip label="Max HR" value={profile?.maxHr} />
              <StatChip label="Resting" value={profile?.restingHr} />
              <StatChip label="LTHR" value={profile?.lthr} />
              <StatChip label="Model" value={MODEL_LABELS[profile?.zoneModel] || profile?.zoneModel || '--'} />
              <StatChip label="Source" value={zoneSource.label} />
            </div>
            <div style={{ margin: '-4px 0 16px', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5 }}>
              <p style={{ margin: 0 }}>{zoneSource.detail}</p>
              {zoneFreshness && <p style={{ margin: '3px 0 0' }}>{zoneFreshness}</p>}
            </div>
            <ZoneBars zones={zones.slice(0, 5)} />
          </>
        ) : (
          <div style={{ borderRadius: 14, padding: 18, background: 'linear-gradient(135deg, var(--accent-dim), var(--danger-dim))', border: '1px solid var(--border-subtle)', textAlign: 'center' }}>
            <Gauge size={30} style={{ color: 'var(--accent)', margin: '0 auto 10px' }} />
            <p style={{ color: 'var(--text-primary)', fontSize: 17, fontWeight: 900, margin: 0 }}>Calibrate your zones</p>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.45, margin: '6px 0 0' }}>Use recent run data or enter your numbers manually to unlock target bpm ranges.</p>
          </div>
        )}
      </section>

      <section style={cardStyle}>
        <button type="button" onClick={derive} disabled={suggesting} style={{ width: '100%', minHeight: 46, borderRadius: 12, background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', fontSize: 14, fontWeight: 900, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: suggesting ? 0.7 : 1 }}>
          <Sparkles size={17} /> {suggesting ? 'Checking your data...' : 'Suggest from my data'}
        </button>

        {suggestError && <p style={{ color: 'var(--danger)', fontSize: 12, fontWeight: 800, margin: '10px 0 0' }}>{suggestError}</p>}

        {suggestion && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
            <p style={{ color: 'var(--text-primary)', fontSize: 15, fontWeight: 900, margin: 0 }}>Suggested calibration</p>
            {!suggestion.available && <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.45, margin: '8px 0 0' }}>{suggestion.note || 'Not enough data yet to suggest HR zones.'}</p>}
            {suggestion.available && (
              <>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
                  <StatChip label="Max HR" value={suggestion.suggestedMaxHr} />
                  <StatChip label="Resting" value={suggestion.suggestedRestingHr} />
                  <StatChip label="Observed" value={suggestion.observedMax} />
                  <StatChip label="Stored" value={suggestion.storedMaxHr} />
                </div>
                {suggestion.maxUnderDetected === true && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: 10, borderRadius: 12, background: 'rgba(249,115,22,0.12)', border: '1px solid rgba(249,115,22,0.3)', marginBottom: 12 }}>
                    <AlertTriangle size={16} color="var(--warning)" style={{ flex: '0 0 auto', marginTop: 1 }} />
                    <p style={{ color: 'var(--warning)', fontSize: 12, fontWeight: 800, lineHeight: 1.4, margin: 0 }}>Your runs show a higher max than stored - consider updating.</p>
                  </div>
                )}
                {Array.isArray(suggestion.zones) && suggestion.zones.length > 0 && <ZoneBars zones={suggestion.zones.slice(0, 5)} />}
              </>
            )}
            <button type="button" onClick={applySuggestion} disabled={!suggestion.available || applying} style={{ width: '100%', marginTop: 14, minHeight: 42, borderRadius: 12, background: suggestion.available ? 'var(--success)' : 'var(--bg-input)', color: suggestion.available ? '#04130A' : 'var(--text-muted)', border: '1px solid var(--border-subtle)', fontSize: 13, fontWeight: 900, cursor: suggestion.available ? 'pointer' : 'not-allowed', opacity: applying ? 0.7 : 1 }}>
              {applying ? 'Applying...' : 'Apply'}
            </button>
          </div>
        )}
      </section>

      <section style={cardStyle}>
        <SectionToggle open={manualOpen} onClick={() => setManualOpen(v => !v)} icon={Activity} title="Manual edit" sub="Use calculated zones or copy exact boundaries from your watch" />
        {manualOpen && (
          <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label style={{ minWidth: 0 }}>
                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, fontWeight: 800, marginBottom: 5 }}>Max HR</span>
                <input type="number" min="80" max="230" inputMode="numeric" value={form.maxHr} onChange={e => setForm({ ...form, maxHr: e.target.value })} style={inputStyle} />
              </label>
              <label style={{ minWidth: 0 }}>
                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, fontWeight: 800, marginBottom: 5 }}>Resting HR</span>
                <input type="number" min="30" max="120" inputMode="numeric" value={form.restingHr} onChange={e => setForm({ ...form, restingHr: e.target.value })} style={inputStyle} />
              </label>
            </div>
            <label>
              <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, fontWeight: 800, marginBottom: 5 }}>LTHR optional</span>
              <input type="number" min="60" max="230" inputMode="numeric" value={form.lthr} onChange={e => setForm({ ...form, lthr: e.target.value })} style={inputStyle} />
            </label>
            <label>
              <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, fontWeight: 800, marginBottom: 5 }}>Model</span>
              <select value={form.zoneModel} onChange={e => setForm({ ...form, zoneModel: e.target.value })} style={inputStyle}>
                <option value="hrr">HR Reserve</option>
                <option value="maxhr">Max-HR %</option>
                <option value="lthr">LTHR</option>
                <option value="custom">Copy zones from watch</option>
              </select>
            </label>
            {form.zoneModel === 'custom' && (
              <div>
                <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.45, margin: '0 0 8px' }}>Enter the starting bpm shown by your watch for each zone. Forged Hybrid will use these exact boundaries instead of estimating from one workout.</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 7 }}>
                  {form.customMinimums.map((value, index) => (
                    <label key={`custom-zone-${index + 1}`} style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', color: ZONE_COLORS[index], fontSize: 11, fontWeight: 900, marginBottom: 5 }}>Z{index + 1}</span>
                      <input
                        type="number"
                        min="30"
                        max="230"
                        inputMode="numeric"
                        aria-label={`Zone ${index + 1} starts at bpm`}
                        value={value}
                        onChange={(event) => setForm((current) => ({
                          ...current,
                          customMinimums: current.customMinimums.map((entry, itemIndex) => itemIndex === index ? event.target.value : entry),
                        }))}
                        style={{ ...inputStyle, padding: '9px 6px', textAlign: 'center' }}
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}
            {manualError && <p style={{ color: 'var(--danger)', fontSize: 12, fontWeight: 800, margin: 0 }}>{manualError}</p>}
            <button type="button" onClick={saveManual} disabled={savingManual} style={{ minHeight: 44, borderRadius: 12, background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', fontSize: 14, fontWeight: 900, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: savingManual ? 0.7 : 1 }}>
              <Save size={16} /> {savingManual ? 'Saving...' : 'Save'}
            </button>
          </div>
        )}
      </section>

      <section style={cardStyle}>
        <SectionToggle open={fieldOpen} onClick={() => setFieldOpen(v => !v)} icon={HeartPulse} title="Field test" sub="20-min hard effort; sets your LTHR." />
        {fieldOpen && (
          <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label style={{ minWidth: 0 }}>
                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, fontWeight: 800, marginBottom: 5 }}>Avg HR</span>
                <input type="number" min="60" max="230" inputMode="numeric" value={fieldForm.avgHr} onChange={e => setFieldForm({ ...fieldForm, avgHr: e.target.value })} style={inputStyle} />
              </label>
              <label style={{ minWidth: 0 }}>
                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, fontWeight: 800, marginBottom: 5 }}>Duration</span>
                <input type="number" min="15" max="90" inputMode="numeric" value={fieldForm.durationMinutes} onChange={e => setFieldForm({ ...fieldForm, durationMinutes: e.target.value })} style={inputStyle} />
              </label>
            </div>
            {fieldError && <p style={{ color: 'var(--danger)', fontSize: 12, fontWeight: 800, margin: 0 }}>{fieldError}</p>}
            <button type="button" onClick={saveFieldTest} disabled={savingField} style={{ minHeight: 44, borderRadius: 12, background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', fontSize: 14, fontWeight: 900, cursor: 'pointer', opacity: savingField ? 0.7 : 1 }}>
              {savingField ? 'Saving...' : 'Save field test'}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
