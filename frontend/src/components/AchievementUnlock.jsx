import { useEffect } from 'react'
import * as Icons from 'lucide-react'
import { BadgeCheck } from 'lucide-react'

export default function AchievementUnlock({ badge, onDismiss }) {
  useEffect(() => {
    if (!badge) return
    const timer = setTimeout(() => {
      onDismiss?.()
    }, 4000)
    return () => clearTimeout(timer)
  }, [badge, onDismiss])

  if (!badge) return null

  const IconComponent = badge.icon && Icons[badge.icon] ? Icons[badge.icon] : BadgeCheck
  const accent = badge.color || '#EAB308'

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <style>{`
        @keyframes popIn {
          from { transform: scale(0.5); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
      `}</style>
      <div style={{
        width: '90%',
        maxWidth: 360,
        borderRadius: 20,
        border: `2px solid ${accent}`,
        background: 'var(--bg-card)',
        padding: 24,
        textAlign: 'center',
        color: 'var(--text-primary)',
        animation: 'popIn 280ms ease',
        boxShadow: `0 15px 35px rgba(234,179,8,0.25)`
      }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', margin: '0 auto 16px', background: `${accent}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <IconComponent size={32} color={accent} />
        </div>
        <p style={{ fontSize: 11, letterSpacing: 2, fontWeight: 700, color: accent }}>ACHIEVEMENT UNLOCKED</p>
        <h3 style={{ fontSize: 22, fontWeight: 900, marginTop: 8 }}>{badge.name}</h3>
        {badge.description && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>{badge.description}</p>
        )}
        <button
          type="button"
          onClick={onDismiss}
          style={{
            marginTop: 18,
            width: '100%',
            borderRadius: 12,
            border: 'none',
            padding: '10px 12px',
            fontWeight: 700,
            fontSize: 13,
            background: accent,
            color: '#000',
            cursor: 'pointer'
          }}
        >
          Continue
        </button>
      </div>
    </div>
  )
}
