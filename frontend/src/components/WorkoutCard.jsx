import { useMemo } from 'react'
import { Copy, Share2 } from 'lucide-react'

export default function WorkoutCard({ workoutType = 'Workout', date, stats = {}, summaryText = '' }) {
  const formattedDate = useMemo(() => {
    if (!date) return new Date().toLocaleDateString()
    const d = new Date(date)
    return Number.isNaN(d.getTime()) ? String(date) : d.toLocaleDateString()
  }, [date])

  const cardText = useMemo(() => {
    if (summaryText) return summaryText
    const statText = Object.entries(stats)
      .filter(([, v]) => v !== null && v !== undefined && String(v) !== '')
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | ')
    return `FORGE ${workoutType} · ${formattedDate}${statText ? ` · ${statText}` : ''}`
  }, [summaryText, workoutType, formattedDate, stats])

  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(cardText)
      window.alert('Workout summary copied')
    } catch {
      window.alert(cardText)
    }
  }

  const shareSummary = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: `FORGE ${workoutType}`, text: cardText })
        return
      } catch {}
    }
    await copySummary()
  }

  return (
    <div className="rounded-2xl p-4 space-y-3" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}>
      <div className="rounded-xl p-4" style={{ background: '#1a1d2e', border: '1px solid #2a2d3e' }}>
        <p className="text-xs font-bold tracking-wide" style={{ color: '#EAB308' }}>FORGE</p>
        <p className="text-lg font-black mt-1" style={{ color: '#ffffff' }}>{workoutType}</p>
        <p className="text-xs mt-1" style={{ color: '#a1a1aa' }}>{formattedDate}</p>
        <div className="grid grid-cols-2 gap-2 mt-3">
          {Object.entries(stats).map(([label, value]) => (
            <div key={label} className="rounded-lg p-2" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}>
              <p className="text-[10px] uppercase" style={{ color: '#a1a1aa' }}>{label}</p>
              <p className="text-sm font-bold" style={{ color: '#EAB308' }}>{value}</p>
            </div>
          ))}
        </div>
      </div>

      <p className="text-xs" style={{ color: '#a1a1aa' }}>Screenshot this to share</p>
      <div className="flex gap-2">
        <button onClick={copySummary} className="rounded-lg px-3 py-2 text-xs font-bold flex items-center gap-1" style={{ background: '#1a1d2e', color: '#EAB308', border: '1px solid #2a2d3e' }}>
          <Copy size={14} /> Copy Link
        </button>
        <button onClick={shareSummary} className="rounded-lg px-3 py-2 text-xs font-bold flex items-center gap-1" style={{ background: '#EAB308', color: '#0f1117' }}>
          <Share2 size={14} /> Share
        </button>
      </div>
    </div>
  )
}
