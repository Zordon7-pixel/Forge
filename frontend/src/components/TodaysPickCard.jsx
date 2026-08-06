import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Footprints } from 'lucide-react'
import api from '../lib/api'

const GEO_OPTIONS = {
  enableHighAccuracy: false,
  timeout: 2500,
  maximumAge: 15 * 60 * 1000,
}

function getPosition() {
  if (!navigator.geolocation) return Promise.resolve(null)

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position),
      () => resolve(null),
      GEO_OPTIONS
    )
  })
}

function shoeDisplayName(shoe) {
  if (!shoe) return ''
  if (typeof shoe === 'string') return shoe

  const pieces = [shoe.brand, shoe.model].filter(Boolean)
  const base = pieces.length ? pieces.join(' ') : shoe.name || shoe.nickname || ''
  if (shoe.nickname && base && !base.includes(shoe.nickname)) return `${base} (${shoe.nickname})`
  return base || shoe.label || ''
}

function apparelItemLabel(item) {
  if (!item) return ''
  if (typeof item === 'string') return item
  return item.label || item.name || item.item || item.type || ''
}

export default function TodaysPickCard({ runType = 'easy', surface = 'road' }) {
  const [state, setState] = useState({ loading: true, error: false, data: null })
  const [showWhy, setShowWhy] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function loadRecommendation() {
      setState({ loading: true, error: false, data: null })
      try {
        const position = await getPosition()
        const params = { run_type: runType || 'easy', surface: surface || 'road' }
        if (position?.coords) {
          params.lat = position.coords.latitude
          params.lon = position.coords.longitude
        }

        const res = await api.get('/gear/recommendation', { params })
        if (!cancelled) setState({ loading: false, error: false, data: res.data || null })
      } catch (error) {
        console.error('[TodaysPickCard] recommendation failed:', error?.message)
        if (!cancelled) setState({ loading: false, error: true, data: null })
      }
    }

    loadRecommendation()
    return () => {
      cancelled = true
    }
  }, [runType, surface])

  const pick = state.data || {}
  const shoe = pick.shoe?.shoe
  const shoeName = shoeDisplayName(shoe)
  const apparelItems = useMemo(
    () => (Array.isArray(pick.apparel?.items) ? pick.apparel.items.map(apparelItemLabel).filter(Boolean) : []),
    [pick.apparel?.items]
  )
  const hasShoePick = Boolean(shoeName)
  const notes = pick.apparel?.notes
  const hasApparelNotes = typeof notes === 'string' || (Array.isArray(notes) && notes.length > 0)
  const apparelNotes = Array.isArray(notes) ? notes.join(' ') : notes

  if (state.loading) {
    return (
      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-3">
          <span style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--accent-dim)', display: 'grid', placeItems: 'center' }}>
            <Footprints size={20} color="var(--accent)" />
          </span>
          <div className="min-w-0 flex-1">
            <div style={{ width: 96, height: 12, borderRadius: 999, background: 'var(--bg-input)', marginBottom: 8 }} />
            <div style={{ width: '70%', height: 10, borderRadius: 999, background: 'var(--bg-input)' }} />
          </div>
          <span
            aria-label="Loading today's pick"
            style={{ width: 18, height: 18, borderRadius: '50%', border: '2px solid var(--border-subtle)', borderTopColor: 'var(--accent)', animation: 'spin 0.8s linear infinite' }}
          />
        </div>
      </section>
    )
  }

  if (state.error) {
    return (
      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Couldn&apos;t load today&apos;s pick.</p>
      </section>
    )
  }

  if (!hasShoePick) {
    return (
      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-3">
          <span style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(148,163,184,0.14)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
            <Footprints size={20} color="#94A3B8" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black" style={{ color: 'var(--text-primary)', margin: 0 }}>Today&apos;s pick</p>
            <Link to="/gear" className="text-xs font-bold" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
              Add your shoes to get recommendations
            </Link>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-start gap-3">
        <span style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--accent-dim)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Footprints size={20} color="var(--accent)" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', margin: 0, letterSpacing: 0 }}>Today&apos;s pick</p>
              <p className="text-lg font-black" style={{ color: 'var(--text-primary)', margin: '2px 0 0', lineHeight: 1.2 }}>{shoeName}</p>
            </div>
            {pick.weather?.available && (
              <span className="text-xs font-bold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                {Math.round(Number(pick.weather.tempF))}&deg;F · {pick.weather.conditions}
              </span>
            )}
          </div>

          {pick.shoe?.warning && (
            <p className="text-xs font-bold mt-2" style={{ color: 'var(--warning)', marginBottom: 0 }}>{pick.shoe.warning}</p>
          )}
        </div>
      </div>

      <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
        <p className="text-sm font-bold" style={{ color: 'var(--text-primary)', margin: 0 }}>{pick.apparel?.summary || 'Apparel recommendation'}</p>
        {apparelItems.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {apparelItems.map((item) => (
              <span key={item} className="text-xs font-semibold" style={{ color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '4px 8px' }}>
                {item}
              </span>
            ))}
          </div>
        )}
        {!pick.weather?.available && (
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)', marginBottom: 0 }}>Live weather unavailable. Showing generic apparel.</p>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowWhy((value) => !value)}
        className="text-xs font-bold"
        style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', padding: 0, cursor: 'pointer' }}
      >
        {showWhy ? 'Hide why' : 'Why'}
      </button>

      {showWhy && (
        <div className="space-y-2 pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {pick.shoe?.reason && <p className="text-xs" style={{ color: 'var(--text-muted)', margin: 0 }}>{pick.shoe.reason}</p>}
          {Array.isArray(pick.shoe?.alternatives) && pick.shoe.alternatives.length > 0 && (
            <div>
              <p className="text-xs font-bold" style={{ color: 'var(--text-primary)', margin: '8px 0 4px' }}>Alternates</p>
              {pick.shoe.alternatives.map((alternative) => (
                <p key={alternative.shoe?.id || shoeDisplayName(alternative.shoe)} className="text-xs" style={{ color: 'var(--text-muted)', margin: '3px 0' }}>
                  {shoeDisplayName(alternative.shoe)} - {alternative.reason}
                </p>
              ))}
            </div>
          )}
          {hasApparelNotes && <p className="text-xs" style={{ color: 'var(--text-muted)', margin: 0 }}>{apparelNotes}</p>}
        </div>
      )}
    </section>
  )
}
