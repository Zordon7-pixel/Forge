import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Footprints, Pencil, Plus, Search, X } from 'lucide-react'
import api from '../lib/api'
import LoadingRunner from '../components/LoadingRunner'
import TodaysPickCard from '../components/TodaysPickCard'

const CATEGORIES = [
  { value: 'daily_trainer', label: 'Daily trainer' },
  { value: 'tempo', label: 'Tempo' },
  { value: 'race', label: 'Race' },
  { value: 'trail', label: 'Trail' },
  { value: 'stability', label: 'Stability' },
]
const SURFACES = [
  { value: 'road', label: 'Road' },
  { value: 'trail', label: 'Trail' },
  { value: 'both', label: 'Road + trail' },
]
const INTENTS = [
  { value: 'easy', label: 'Easy' },
  { value: 'recovery', label: 'Recovery' },
  { value: 'long', label: 'Long' },
  { value: 'tempo', label: 'Tempo' },
  { value: 'threshold', label: 'Threshold' },
  { value: 'intervals', label: 'Intervals' },
  { value: 'speed', label: 'Speed' },
  { value: 'race', label: 'Race' },
  { value: 'trail', label: 'Trail' },
]
const CUSHION = [
  { value: '', label: 'Not set' },
  { value: 'max', label: 'Max' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'firm', label: 'Firm' },
]
const RUN_TYPES = ['easy', 'recovery', 'long', 'tempo', 'intervals', 'race', 'trail']

const fieldStyle = {
  width: '100%',
  padding: '11px 12px',
  borderRadius: 10,
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
  fontSize: 14,
  boxSizing: 'border-box',
}

function categoryLabel(value) {
  return CATEGORIES.find((category) => category.value === value)?.label || 'Daily trainer'
}

function displayDate(value) {
  if (!value) return ''
  return new Date(`${value}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatSpec(value, suffix) {
  return value === null || value === undefined || value === '' ? null : `${Number(value).toLocaleString()}${suffix}`
}

function FieldLabel({ children }) {
  return <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 5px', fontWeight: 700 }}>{children}</p>
}

function TagToggle({ selected, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        minHeight: 36,
        padding: '7px 11px',
        borderRadius: 999,
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`,
        background: selected ? 'var(--accent-dim)' : 'var(--bg-input)',
        color: selected ? 'var(--accent)' : 'var(--text-muted)',
        fontSize: 12,
        fontWeight: 800,
      }}
    >
      {children}
    </button>
  )
}

export default function Gear() {
  const [shoes, setShoes] = useState([])
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [showRetired, setShowRetired] = useState(false)
  const [addMode, setAddMode] = useState('catalog')
  const [catalogQuery, setCatalogQuery] = useState('')
  const [catalogResults, setCatalogResults] = useState([])
  const [catalogSearching, setCatalogSearching] = useState(false)
  const [selectedCatalog, setSelectedCatalog] = useState(null)
  const [brand, setBrand] = useState('')
  const [model, setModel] = useState('')
  const [nickname, setNickname] = useState('')
  const [color, setColor] = useState('')
  const [purchaseDate, setPurchaseDate] = useState('')
  const [category, setCategory] = useState('daily_trainer')
  const [surface, setSurface] = useState('road')
  const [intentTags, setIntentTags] = useState(['easy', 'long'])
  const [wetOk, setWetOk] = useState('')
  const [cushion, setCushion] = useState('')
  const [adding, setAdding] = useState(false)
  const [formError, setFormError] = useState('')
  const [editingShoe, setEditingShoe] = useState(null)
  const [editForm, setEditForm] = useState(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [runType, setRunType] = useState('easy')
  const [runSurface, setRunSurface] = useState('road')

  const load = async (retired = false) => {
    setLoading(true)
    setPageError('')
    try {
      const res = await api.get(`/gear/shoes${retired ? '?retired=true' : ''}`)
      setShoes(res.data.shoes || [])
    } catch (error) {
      console.error('[Closet] shoe list failed:', error?.message)
      setPageError('Could not load your closet. Pull down or reopen this page to retry.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(showRetired) }, [showRetired])

  useEffect(() => {
    if (!showAdd || addMode !== 'catalog' || selectedCatalog || catalogQuery.trim().length < 2) {
      setCatalogResults([])
      setCatalogSearching(false)
      return undefined
    }
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setCatalogSearching(true)
      try {
        const res = await api.get('/gear/catalog', { params: { q: catalogQuery.trim() } })
        if (!cancelled) setCatalogResults(res.data?.shoes || [])
      } catch (error) {
        console.error('[Closet] catalog search failed:', error?.message)
        if (!cancelled) setCatalogResults([])
      } finally {
        if (!cancelled) setCatalogSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [addMode, catalogQuery, selectedCatalog, showAdd])

  const activeCount = useMemo(() => shoes.filter((shoe) => !shoe.is_retired).length, [shoes])
  const alerts = useMemo(() => shoes.filter((shoe) => shoe.alert && !shoe.is_retired), [shoes])

  const resetAdd = () => {
    setAddMode('catalog')
    setCatalogQuery('')
    setCatalogResults([])
    setSelectedCatalog(null)
    setBrand('')
    setModel('')
    setNickname('')
    setColor('')
    setPurchaseDate('')
    setCategory('daily_trainer')
    setSurface('road')
    setIntentTags(['easy', 'long'])
    setWetOk('')
    setCushion('')
    setFormError('')
  }

  const closeAdd = () => {
    setShowAdd(false)
    resetAdd()
  }

  const selectCatalog = (shoe) => {
    setSelectedCatalog(shoe)
    setCatalogQuery(`${shoe.brand} ${shoe.model}`)
    setCatalogResults([])
    setFormError('')
  }

  const addShoe = async () => {
    if (!selectedCatalog && (!brand.trim() || !model.trim())) return
    setAdding(true)
    setFormError('')
    try {
      await api.post('/gear/shoes', selectedCatalog
        ? {
            catalog_id: selectedCatalog.id,
            nickname,
            color,
            purchase_date: purchaseDate,
          }
        : {
            brand,
            model,
            nickname,
            color,
            purchase_date: purchaseDate,
            category,
            surface,
            intent_tags: intentTags,
            wet_ok: wetOk,
            cushion,
          })
      closeAdd()
      await load(showRetired)
    } catch (error) {
      console.error('[Closet] add shoe failed:', error?.message)
      setFormError(error?.response?.data?.error || 'Could not add this shoe.')
    } finally {
      setAdding(false)
    }
  }

  const startEdit = (shoe) => {
    setEditingShoe(shoe)
    setEditForm({
      nickname: shoe.nickname || '',
      category: shoe.category || 'daily_trainer',
      surface: shoe.surface || 'road',
      intent_tags: Array.isArray(shoe.intent_tags) ? shoe.intent_tags : [],
      wet_ok: shoe.wet_ok === null || shoe.wet_ok === undefined ? '' : String(Number(shoe.wet_ok)),
      cushion: shoe.cushion || '',
      recommended_miles: String(shoe.recommended_miles || 450),
    })
    setFormError('')
  }

  const toggleEditIntent = (intent) => {
    setEditForm((current) => ({
      ...current,
      intent_tags: current.intent_tags.includes(intent)
        ? current.intent_tags.filter((value) => value !== intent)
        : [...current.intent_tags, intent],
    }))
  }

  const saveEdit = async () => {
    if (!editingShoe || !editForm) return
    setSavingEdit(true)
    setFormError('')
    try {
      await api.patch(`/gear/shoes/${editingShoe.id}`, editForm)
      setEditingShoe(null)
      setEditForm(null)
      await load(showRetired)
    } catch (error) {
      console.error('[Closet] edit shoe failed:', error?.message)
      setFormError(error?.response?.data?.error || 'Could not save this shoe.')
    } finally {
      setSavingEdit(false)
    }
  }

  const retire = async (id) => {
    try {
      await api.post(`/gear/shoes/${id}/retire`)
      await load(showRetired)
    } catch (error) {
      console.error('[Closet] retire shoe failed:', error?.message)
      setPageError('Could not retire that shoe.')
    }
  }

  const remove = async (id) => {
    if (!window.confirm('Delete this shoe from your closet? Existing run history will stay intact.')) return
    try {
      await api.delete(`/gear/shoes/${id}`)
      await load(showRetired)
    } catch (error) {
      console.error('[Closet] delete shoe failed:', error?.message)
      setPageError('Could not delete that shoe.')
    }
  }

  if (loading) return <LoadingRunner message="Loading closet" />

  return (
    <div className="space-y-4 py-2">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 900, textTransform: 'uppercase', margin: '0 0 3px', letterSpacing: 0 }}>Shoe rotation</p>
          <h1 className="text-2xl font-black" style={{ color: 'var(--text-primary)', margin: 0 }}>Forged Closet</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)', margin: '4px 0 0' }}>{activeCount} active pair{activeCount !== 1 ? 's' : ''}</p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', borderRadius: 10, minHeight: 40, padding: '8px 13px', fontSize: 13, fontWeight: 850, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <Plus size={15} /> Add
        </button>
      </header>

      {pageError && (
        <div role="alert" style={{ background: 'var(--danger-dim)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10, padding: 12, color: 'var(--danger)', fontSize: 13 }}>
          {pageError}
        </div>
      )}

      <section style={{ borderTop: '1px solid var(--border-subtle)', borderBottom: '1px solid var(--border-subtle)', padding: '14px 0' }}>
        <div className="flex items-center justify-between gap-3" style={{ marginBottom: 10 }}>
          <div>
            <h2 style={{ color: 'var(--text-primary)', fontSize: 17, fontWeight: 900, margin: 0 }}>What should I wear?</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '3px 0 0' }}>Pick the session and surface. Weather is included when available.</p>
          </div>
          <Footprints size={22} color="var(--accent)" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8, marginBottom: 10 }}>
          <label>
            <span className="sr-only">Run type</span>
            <select value={runType} onChange={(event) => setRunType(event.target.value)} style={fieldStyle}>
              {RUN_TYPES.map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
            </select>
          </label>
          <label>
            <span className="sr-only">Run surface</span>
            <select value={runSurface} onChange={(event) => setRunSurface(event.target.value)} style={fieldStyle}>
              {SURFACES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>
        <TodaysPickCard runType={runType} surface={runSurface} />
      </section>

      {alerts.length > 0 && (
        <div style={{ background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.3)', borderRadius: 10, padding: '10px 12px' }}>
          <p style={{ fontSize: 13, fontWeight: 800, color: 'var(--warning)', margin: 0 }}>
            Inspect {alerts.length} pair{alerts.length === 1 ? '' : 's'} for tread, cushioning, and comfort before the next run.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <h2 style={{ color: 'var(--text-primary)', fontSize: 17, fontWeight: 900, margin: 0 }}>Your rotation</h2>
        <button type="button" onClick={() => setShowRetired((value) => !value)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 12, fontWeight: 800, padding: 4 }}>
          {showRetired ? 'Active only' : 'Include retired'}
        </button>
      </div>

      {shoes.length === 0 ? (
        <section className="p-8 text-center" style={{ borderTop: '1px solid var(--border-subtle)', borderBottom: '1px solid var(--border-subtle)' }}>
          <Footprints size={34} style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }} />
          <p style={{ color: 'var(--text-primary)', fontWeight: 850, fontSize: 15, margin: 0 }}>Add your first running shoe</p>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '5px 0 14px' }}>Forged Hybrid will track mileage and help rotate the right pair for each session.</p>
          <button type="button" onClick={() => setShowAdd(true)} style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', borderRadius: 10, padding: '10px 15px', fontWeight: 850 }}>Add a shoe</button>
        </section>
      ) : shoes.map((shoe) => {
        const limit = Math.max(1, Number(shoe.recommended_miles || 450))
        const miles = Number(shoe.total_miles || 0)
        const pct = Math.max(0, Math.min(100, Number(shoe.pct_used || (miles / limit) * 100)))
        const atEstimate = miles >= limit
        const inspect = pct >= 80 && !shoe.is_retired
        const barColor = atEstimate ? 'var(--danger)' : inspect ? 'var(--warning)' : 'var(--success)'
        const specs = [
          formatSpec(shoe.catalog_drop_mm, ' mm drop'),
          formatSpec(shoe.catalog_weight_g, ' g'),
          shoe.catalog_plate_type && shoe.catalog_plate_type !== 'none' ? `${String(shoe.catalog_plate_type).replace(/_/g, ' ')} plate` : null,
        ].filter(Boolean)
        return (
          <article key={shoe.id} style={{ background: 'var(--bg-card)', borderRadius: 8, padding: 15, border: `1px solid ${inspect ? 'rgba(249,115,22,0.45)' : 'var(--border-subtle)'}`, opacity: shoe.is_retired ? 0.68 : 1 }}>
            {inspect && !shoe.is_retired && (
              <p style={{ fontSize: 12, color: atEstimate ? 'var(--danger)' : 'var(--warning)', fontWeight: 800, margin: '0 0 9px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertTriangle size={14} /> {atEstimate ? 'At mileage estimate - inspect before running' : 'Wear check due soon'}
              </p>
            )}
            <div className="flex items-start justify-between gap-3">
              <div style={{ minWidth: 0 }}>
                <h3 style={{ fontSize: 16, fontWeight: 900, color: 'var(--text-primary)', margin: 0 }}>{shoe.brand} {shoe.model}</h3>
                {shoe.nickname && <p style={{ fontSize: 12, color: 'var(--accent)', margin: '2px 0 0', fontWeight: 800 }}>{shoe.nickname}</p>}
                <div className="flex flex-wrap gap-1.5" style={{ marginTop: 7 }}>
                  {[categoryLabel(shoe.category), shoe.surface || 'road', shoe.cushion].filter(Boolean).map((label) => (
                    <span key={label} style={{ padding: '3px 7px', borderRadius: 999, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontSize: 10, fontWeight: 800, textTransform: 'capitalize' }}>{String(label).replace(/_/g, ' ')}</span>
                  ))}
                </div>
                {specs.length > 0 && <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '7px 0 0' }}>{specs.join(' · ')}</p>}
                {shoe.purchase_date && <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '4px 0 0' }}>In rotation since {displayDate(shoe.purchase_date)}</p>}
              </div>
              <p style={{ fontSize: 23, fontWeight: 950, color: barColor, margin: 0, flexShrink: 0 }}>{Math.round(Number(shoe.pct_used || 0))}%</p>
            </div>
            <div style={{ margin: '12px 0 5px' }}>
              <div style={{ height: 8, background: 'var(--bg-input)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: 4, transition: 'width 0.3s ease' }} />
              </div>
              <div className="flex justify-between gap-3" style={{ marginTop: 5 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{miles.toFixed(miles % 1 ? 1 : 0)} of {limit} mi</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{shoe.catalog_id ? 'Manufacturer-matched' : 'Manual profile'}</span>
              </div>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 12px' }}>
              Mileage is an estimate, not a failure date. Retire a pair when tread, ride feel, or comfort changes.
            </p>
            <div className="flex flex-wrap gap-2">
              {!shoe.is_retired && <button type="button" onClick={() => startEdit(shoe)} aria-label={`Edit ${shoe.brand} ${shoe.model}`} style={{ minHeight: 36, fontSize: 12, padding: '7px 11px', borderRadius: 8, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}><Pencil size={13} /> Edit</button>}
              {!shoe.is_retired && <button type="button" onClick={() => retire(shoe.id)} style={{ minHeight: 36, fontSize: 12, padding: '7px 11px', borderRadius: 8, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>Retire</button>}
              <button type="button" onClick={() => remove(shoe.id)} style={{ minHeight: 36, fontSize: 12, padding: '7px 11px', borderRadius: 8, background: 'var(--danger-dim)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--danger)' }}>Delete</button>
            </div>
          </article>
        )
      })}

      {showAdd && (
        <div onClick={closeAdd} className="sheet-backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }}>
          <section onClick={(event) => event.stopPropagation()} className="sheet-panel" aria-label="Add a shoe" style={{ background: 'var(--bg-card)', borderRadius: '18px 18px 0 0', padding: '18px 18px calc(20px + env(safe-area-inset-bottom))', width: '100%', maxHeight: '88vh', overflowY: 'auto' }}>
            <div className="flex items-center justify-between gap-3" style={{ marginBottom: 14 }}>
              <div>
                <h2 style={{ fontSize: 19, fontWeight: 900, color: 'var(--text-primary)', margin: 0 }}>Add to Closet</h2>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '3px 0 0' }}>Search the verified pilot catalog or enter a pair manually.</p>
              </div>
              <button type="button" aria-label="Close add shoe" onClick={closeAdd} style={{ width: 38, height: 38, display: 'grid', placeItems: 'center', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 9, color: 'var(--text-muted)' }}><X size={18} /></button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', background: 'var(--bg-input)', borderRadius: 9, padding: 3, marginBottom: 14 }}>
              {['catalog', 'manual'].map((mode) => (
                <button key={mode} type="button" onClick={() => { setAddMode(mode); setSelectedCatalog(null); setFormError('') }} style={{ minHeight: 38, border: 'none', borderRadius: 7, background: addMode === mode ? 'var(--bg-card)' : 'transparent', color: addMode === mode ? 'var(--text-primary)' : 'var(--text-muted)', fontSize: 13, fontWeight: 850, textTransform: 'capitalize' }}>{mode}</button>
              ))}
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
              {addMode === 'catalog' ? (
                <div>
                  <FieldLabel>Search brand or model</FieldLabel>
                  <div style={{ position: 'relative' }}>
                    <Search size={17} color="var(--text-muted)" style={{ position: 'absolute', left: 12, top: 12 }} />
                    <input value={catalogQuery} onChange={(event) => { setCatalogQuery(event.target.value); setSelectedCatalog(null) }} placeholder="Pegasus, Ghost, Nimbus..." style={{ ...fieldStyle, paddingLeft: 38 }} />
                  </div>
                  {catalogSearching && <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '7px 0 0' }}>Searching catalog...</p>}
                  {!selectedCatalog && catalogQuery.trim().length >= 2 && !catalogSearching && catalogResults.length === 0 && (
                    <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '7px 0 0' }}>No verified match yet. Use Manual to add it without guessed specs.</p>
                  )}
                  {catalogResults.length > 0 && (
                    <div style={{ marginTop: 7, border: '1px solid var(--border-subtle)', borderRadius: 9, overflow: 'hidden' }}>
                      {catalogResults.map((shoe) => (
                        <button key={shoe.id} type="button" onClick={() => selectCatalog(shoe)} style={{ width: '100%', minHeight: 52, textAlign: 'left', padding: '9px 11px', border: 'none', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
                          <span style={{ display: 'block', fontSize: 13, fontWeight: 850 }}>{shoe.brand} {shoe.model}</span>
                          <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>{categoryLabel(shoe.category)} · {shoe.surface} · {shoe.drop_mm ?? '--'} mm drop</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {selectedCatalog && (
                    <div style={{ marginTop: 9, padding: 11, border: '1px solid rgba(34,197,94,0.35)', background: 'rgba(34,197,94,0.08)', borderRadius: 9 }}>
                      <p style={{ color: 'var(--success)', fontSize: 12, fontWeight: 850, margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}><Check size={14} /> Manufacturer-matched</p>
                      <p style={{ color: 'var(--text-primary)', fontSize: 15, fontWeight: 900, margin: '4px 0 0' }}>{selectedCatalog.brand} {selectedCatalog.model}</p>
                      <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '4px 0 0' }}>{categoryLabel(selectedCatalog.category)} · {selectedCatalog.surface} · {selectedCatalog.drop_mm ?? '--'} mm drop · {selectedCatalog.weight_g ?? '--'} g</p>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div><FieldLabel>Brand</FieldLabel><input value={brand} onChange={(event) => setBrand(event.target.value)} maxLength={60} placeholder="Brand" style={fieldStyle} /></div>
                  <div><FieldLabel>Model</FieldLabel><input value={model} onChange={(event) => setModel(event.target.value)} maxLength={100} placeholder="Model and version" style={fieldStyle} /></div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <label><FieldLabel>Category</FieldLabel><select value={category} onChange={(event) => setCategory(event.target.value)} style={fieldStyle}>{CATEGORIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                    <label><FieldLabel>Surface</FieldLabel><select value={surface} onChange={(event) => setSurface(event.target.value)} style={fieldStyle}>{SURFACES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                  </div>
                  <div>
                    <FieldLabel>Best for</FieldLabel>
                    <div className="flex flex-wrap gap-2">{INTENTS.map((intent) => <TagToggle key={intent.value} selected={intentTags.includes(intent.value)} onClick={() => setIntentTags((current) => current.includes(intent.value) ? current.filter((value) => value !== intent.value) : [...current, intent.value])}>{intent.label}</TagToggle>)}</div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <label><FieldLabel>Cushion</FieldLabel><select value={cushion} onChange={(event) => setCushion(event.target.value)} style={fieldStyle}>{CUSHION.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                    <label><FieldLabel>Wet traction</FieldLabel><select value={wetOk} onChange={(event) => setWetOk(event.target.value)} style={fieldStyle}><option value="">Unknown</option><option value="1">Works well</option><option value="0">Avoid</option></select></label>
                  </div>
                </>
              )}

              <div><FieldLabel>Nickname (optional)</FieldLabel><input value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={60} placeholder="Daily driver, race pair..." style={fieldStyle} /></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label><FieldLabel>Color</FieldLabel><input value={color} onChange={(event) => setColor(event.target.value)} maxLength={60} placeholder="Optional" style={fieldStyle} /></label>
                <label><FieldLabel>First used</FieldLabel><input type="date" value={purchaseDate} onChange={(event) => setPurchaseDate(event.target.value)} style={fieldStyle} /></label>
              </div>
              {formError && <p role="alert" style={{ color: 'var(--danger)', fontSize: 12, margin: 0 }}>{formError}</p>}
              <button type="button" onClick={addShoe} disabled={adding || (addMode === 'catalog' ? !selectedCatalog : !brand.trim() || !model.trim())} style={{ minHeight: 48, borderRadius: 10, background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', fontSize: 15, fontWeight: 900, opacity: adding || (addMode === 'catalog' ? !selectedCatalog : !brand.trim() || !model.trim()) ? 0.5 : 1 }}>
                {adding ? 'Adding...' : 'Add to Closet'}
              </button>
            </div>
          </section>
        </div>
      )}

      {editingShoe && editForm && (
        <div onClick={() => { setEditingShoe(null); setEditForm(null); setFormError('') }} className="sheet-backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }}>
          <section onClick={(event) => event.stopPropagation()} className="sheet-panel" aria-label="Edit shoe" style={{ background: 'var(--bg-card)', borderRadius: '18px 18px 0 0', padding: '18px 18px calc(20px + env(safe-area-inset-bottom))', width: '100%', maxHeight: '88vh', overflowY: 'auto' }}>
            <div className="flex items-center justify-between gap-3" style={{ marginBottom: 14 }}>
              <div><h2 style={{ fontSize: 19, fontWeight: 900, color: 'var(--text-primary)', margin: 0 }}>Edit Shoe</h2><p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '3px 0 0' }}>{editingShoe.brand} {editingShoe.model}</p></div>
              <button type="button" aria-label="Close edit shoe" onClick={() => { setEditingShoe(null); setEditForm(null); setFormError('') }} style={{ width: 38, height: 38, display: 'grid', placeItems: 'center', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 9, color: 'var(--text-muted)' }}><X size={18} /></button>
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              <div><FieldLabel>Nickname</FieldLabel><input value={editForm.nickname} onChange={(event) => setEditForm({ ...editForm, nickname: event.target.value })} maxLength={60} style={fieldStyle} /></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label><FieldLabel>Category</FieldLabel><select value={editForm.category} onChange={(event) => setEditForm({ ...editForm, category: event.target.value })} style={fieldStyle}>{CATEGORIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <label><FieldLabel>Surface</FieldLabel><select value={editForm.surface} onChange={(event) => setEditForm({ ...editForm, surface: event.target.value })} style={fieldStyle}>{SURFACES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              </div>
              <div><FieldLabel>Best for</FieldLabel><div className="flex flex-wrap gap-2">{INTENTS.map((intent) => <TagToggle key={intent.value} selected={editForm.intent_tags.includes(intent.value)} onClick={() => toggleEditIntent(intent.value)}>{intent.label}</TagToggle>)}</div></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label><FieldLabel>Cushion</FieldLabel><select value={editForm.cushion} onChange={(event) => setEditForm({ ...editForm, cushion: event.target.value })} style={fieldStyle}>{CUSHION.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <label><FieldLabel>Wet traction</FieldLabel><select value={editForm.wet_ok} onChange={(event) => setEditForm({ ...editForm, wet_ok: event.target.value })} style={fieldStyle}><option value="">Unknown</option><option value="1">Works well</option><option value="0">Avoid</option></select></label>
              </div>
              <div><FieldLabel>Mileage estimate</FieldLabel><input type="number" min="100" max="800" step="25" value={editForm.recommended_miles} onChange={(event) => setEditForm({ ...editForm, recommended_miles: event.target.value })} style={fieldStyle} /></div>
              <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: 0 }}>Use this as an inspection reminder, not an automatic failure date. Comfort and visible wear matter.</p>
              {formError && <p role="alert" style={{ color: 'var(--danger)', fontSize: 12, margin: 0 }}>{formError}</p>}
              <button type="button" onClick={saveEdit} disabled={savingEdit} style={{ minHeight: 48, borderRadius: 10, background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', fontSize: 15, fontWeight: 900, opacity: savingEdit ? 0.55 : 1 }}>{savingEdit ? 'Saving...' : 'Save Shoe'}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
