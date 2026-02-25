import { useState, useEffect } from 'react'
import { Package, Plus, X, AlertTriangle } from 'lucide-react'
import api from '../lib/api'
import LoadingRunner from '../components/LoadingRunner'

const SHOE_BRANDS = {
  'Nike': ['Pegasus 41','Invincible Run 3','Vaporfly 3','Alphafly 3','Structure 25','Zoom Fly 5','React Infinity Run 4','Terra Kiger 9','Wildhorse 8'],
  'Adidas': ['Ultraboost 24','Adizero Adios Pro 3','Boston 12','Solarboost 5','Terrex Trail King','Supernova Rise'],
  'ASICS': ['Gel-Nimbus 26','Gel-Kayano 31','MetaSpeed Sky+','Gel-Cumulus 26','Gel-Trabuco 12','GT-2000 13','Novablast 4'],
  'Brooks': ['Ghost 16','Glycerin 21','Hyperion Elite 4','Adrenaline GTS 24','Catamount 4','Cascadia 17'],
  'New Balance': ['Fresh Foam X 1080v14','FuelCell SC Elite v4','Fresh Foam X 860v14','More v4','Hierro v8'],
  'Saucony': ['Triumph 22','Endorphin Pro 4','Kinvara 15','Endorphin Speed 4','Peregrine 14','Guide 17'],
  'Hoka': ['Clifton 9','Bondi 9','Speedgoat 6','Carbon X 3','Mach 6','Arahi 7','Challenger 7'],
  'On Running': ['Cloudmonster 2','Cloudboom Echo 3','Cloudstratus 4','Cloudvista 2','Cloudrunner 2'],
  'Mizuno': ['Wave Rider 28','Wave Inspire 21','Wave Rebellion Pro 2'],
  'Salomon': ['Speedcross 6','Sense Ride 5','Ultra Glide 3'],
  'Altra': ['Lone Peak 8','Olympus 6','Torin 7'],
  'Other': [],
}

export default function Gear() {
  const [shoes, setShoes] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [showRetired, setShowRetired] = useState(false)
  const [brand, setBrand] = useState('')
  const [model, setModel] = useState('')
  const [nickname, setNickname] = useState('')
  const [color, setColor] = useState('')
  const [purchaseDate, setPurchaseDate] = useState('')
  const [adding, setAdding] = useState(false)

  const load = async (retired = false) => {
    setLoading(true)
    try {
      const res = await api.get(`/gear/shoes${retired ? '?retired=true' : ''}`)
      setShoes(res.data.shoes || [])
    } finally { setLoading(false) }
  }

  useEffect(() => { load(showRetired) }, [showRetired])

  const addShoe = async () => {
    if (!brand || !model) return
    setAdding(true)
    try {
      await api.post('/gear/shoes', { brand, model, nickname, color, purchase_date: purchaseDate })
      setBrand(''); setModel(''); setNickname(''); setColor(''); setPurchaseDate('')
      setShowAdd(false)
      load(showRetired)
    } finally { setAdding(false) }
  }

  const retire = async (id) => {
    await api.post(`/gear/shoes/${id}/retire`)
    load(showRetired)
  }

  const remove = async (id) => {
    if (!window.confirm('Delete this shoe?')) return
    await api.delete(`/gear/shoes/${id}`)
    load(showRetired)
  }

  if (loading) return <LoadingRunner message="Loading gear" />

  const alerts = shoes.filter(s => s.alert)

  return (
    <div className="space-y-4 py-2">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>My Gear</h2>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{shoes.length} active shoe{shoes.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={() => setShowAdd(true)} style={{ background: '#EAB308', color: '#000', border: 'none', borderRadius: 10, padding: '8px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> Add Shoe
        </button>
      </div>

      {alerts.length > 0 && (
        <div style={{ background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.3)', borderRadius: 12, padding: '10px 14px' }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: '#f97316', margin: 0 }}>
            {alerts.length} shoe{alerts.length > 1 ? 's' : ''} need{alerts.length === 1 ? 's' : ''} attention
          </p>
        </div>
      )}

      {shoes.length === 0 ? (
        <div className="rounded-2xl p-8 text-center" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <Package size={32} style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }} />
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No shoes yet. Add your first pair to track mileage.</p>
        </div>
      ) : (
        shoes.map(shoe => {
          const miles = Number(shoe.total_miles || 0)
          const pct = Math.min(100, (miles / 500) * 100)
          const barColor = miles >= 500 ? '#ef4444' : miles >= 400 ? '#EAB308' : '#22c55e'
          return (
            <div key={shoe.id} style={{ background: 'var(--bg-card)', borderRadius: 16, padding: 16, border: `1.5px solid ${shoe.alert ? 'rgba(249,115,22,0.4)' : 'var(--border-subtle)'}`, boxShadow: shoe.alert ? '0 0 10px rgba(249,115,22,0.15)' : 'none' }}>
              {miles >= 500 && (
                <div style={{ background: 'rgba(239,68,68,0.1)', borderRadius: 8, padding: '6px 10px', marginBottom: 10 }}>
                  <p style={{ fontSize: 12, color: '#ef4444', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <AlertTriangle size={14} /> Replace soon
                  </p>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <p style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>{shoe.brand} {shoe.model}</p>
                  {shoe.nickname && <p style={{ fontSize: 12, color: 'var(--accent)', margin: '2px 0 0' }}>{shoe.nickname}</p>}
                  {shoe.purchase_date && <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0' }}>Since {new Date(shoe.purchase_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>}
                </div>
                <p style={{ fontSize: 24, fontWeight: 900, color: barColor, margin: 0 }}>{Math.round((miles / 500) * 100)}%</p>
              </div>
              <div style={{ margin: '12px 0 6px' }}>
                <div style={{ height: 8, background: 'var(--bg-input)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: 4, transition: 'width 0.6s ease' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{shoe.total_miles} / 500 mi</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>500 mi threshold</span>
                </div>
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
                {miles < 500 ? `~${Math.max(0, Math.round(500 - miles))} miles remaining` : 'Over threshold'}
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => retire(shoe.id)} style={{ fontSize: 12, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)', cursor: 'pointer' }}>Retire</button>
                <button onClick={() => remove(shoe.id)} style={{ fontSize: 12, padding: '6px 12px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', cursor: 'pointer' }}>Delete</button>
              </div>
            </div>
          )
        })
      )}

      <button onClick={() => setShowRetired(v => !v)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer', padding: '4px 0' }}>
        {showRetired ? 'Hide retired shoes' : 'View retired shoes'}
      </button>

      {showAdd && (
        <div onClick={() => setShowAdd(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', padding: 24, width: '100%', maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <p style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Add Shoe</p>
              <button onClick={() => setShowAdd(false)} style={{ background: 'var(--bg-input)', border: 'none', borderRadius: 8, padding: '6px 12px', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={16} /></button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 4px' }}>Brand</p>
                <select value={brand} onChange={e => { setBrand(e.target.value); setModel('') }} style={{ width: '100%', padding: '10px 12px', borderRadius: 10, background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', fontSize: 14 }}>
                  <option value="">Select brand</option>
                  {Object.keys(SHOE_BRANDS).map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              <div>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 4px' }}>Model</p>
                <input
                  list="model-suggestions"
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  placeholder={brand ? 'Type or select model' : 'Select brand first'}
                  disabled={!brand}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 10, background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', fontSize: 14, boxSizing: 'border-box' }}
                />
                <datalist id="model-suggestions">
                  {(SHOE_BRANDS[brand] || []).map(m => <option key={m} value={m} />)}
                </datalist>
              </div>
              <div>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 4px' }}>Nickname (optional)</p>
                <input value={nickname} onChange={e => setNickname(e.target.value)} placeholder="e.g. Race Day, Daily Driver" style={{ width: '100%', padding: '10px 12px', borderRadius: 10, background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', fontSize: 14, boxSizing: 'border-box' }} />
              </div>
              <div>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 4px' }}>Color (optional)</p>
                <input value={color} onChange={e => setColor(e.target.value)} placeholder="e.g. Black/Yellow" style={{ width: '100%', padding: '10px 12px', borderRadius: 10, background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', fontSize: 14, boxSizing: 'border-box' }} />
              </div>
              <div>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 4px' }}>Purchase Date (optional)</p>
                <input type="date" value={purchaseDate} onChange={e => setPurchaseDate(e.target.value)} style={{ width: '100%', padding: '10px 12px', borderRadius: 10, background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', fontSize: 14, boxSizing: 'border-box' }} />
              </div>
              <button onClick={addShoe} disabled={adding || !brand || !model} style={{ padding: '12px 0', borderRadius: 12, background: '#EAB308', color: '#000', border: 'none', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: (!brand || !model) ? 0.5 : 1 }}>
                {adding ? 'Adding...' : 'Add Shoe'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
