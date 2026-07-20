import { useEffect, useState } from 'react'
import api from '../lib/api'
import { resolveReadiness } from '../lib/truthConsistency'

function bandColor(band) {
  if (band === 'GREEN') return 'var(--success)'
  if (band === 'AMBER') return 'var(--warning)'
  if (band === 'RED') return 'var(--danger)'
  return 'var(--text-muted)'
}

export default function HeaderReadinessChip({ onOpen, refreshKey }) {
  const [state, setState] = useState({ loading: true, data: null })

  useEffect(() => {
    let active = true

    const loadReadiness = async () => {
      try {
        const response = await api.get('/recovery/readiness')
        if (active) setState({ loading: false, data: response.data || null })
      } catch (error) {
        if (active) setState({ loading: false, data: null })
        if (error?.response?.status !== 402) {
          console.error('[header/readiness] load failed:', error?.message || error)
        }
      }
    }

    loadReadiness()
    return () => { active = false }
  }, [refreshKey])

  const readiness = resolveReadiness(state.data)
  const color = readiness.available ? bandColor(state.data?.band) : 'var(--text-muted)'

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={readiness.available ? `Open recovery readiness, score ${readiness.score}` : 'Open recovery readiness'}
      aria-busy={state.loading}
      className="pressable flex h-9 min-w-0 items-center justify-center gap-2 rounded-lg px-2"
      style={{
        width: 104,
        maxWidth: '32vw',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        color: 'var(--text-primary)',
      }}
    >
      <span className="min-w-0 text-left">
        <span className="block truncate text-[8px] font-black uppercase" style={{ color: 'var(--text-muted)', lineHeight: 1, letterSpacing: 0 }}>
          Readiness
        </span>
        <span className="mt-1 block truncate text-xs font-black" style={{ color, lineHeight: 1 }}>
          {state.loading ? '...' : readiness.display}
        </span>
      </span>
      <span aria-hidden="true" className="h-4 w-1 shrink-0 rounded-full" style={{ background: color }} />
    </button>
  )
}
