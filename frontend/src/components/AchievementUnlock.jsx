import { useEffect } from 'react'
import { BadgeCheck } from 'lucide-react'

export default function AchievementUnlock({ badge, onDismiss }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 4000)
    return () => clearTimeout(t)
  }, [onDismiss])

  return (
    <div
      onClick={onDismiss}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <style>{`
        @keyframes popIn {
          from { transform: scale(0.5); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
      `}</style>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)',
          border: '2px solid #EAB308',
          borderRadius: 24,
          padding: 32,
          maxWidth: 300,
          width: '90%',
          textAlign: 'center',
          animation: 'popIn 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards',
          boxShadow: '0 0 40px rgba(234,179,8,0.3)',
        }}
      >
        <BadgeCheck size={56} color="#EAB308" style={{ margin: '0 auto 16px' }} />
        <p style={{ fontSize: 11, fontWeight: 700, color: '#EAB308', letterSpacing: 2, textTransform: 'uppercase', margin: '0 0 8px' }}>
          Achievement Unlocked
        </p>
        <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)', margin: '0 0 8px' }}>
          {badge.name}
        </p>
        {badge.description && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 20px', lineHeight: 1.5 }}>
            {badge.description}
          </p>
        )}
        <button
          onClick={onDismiss}
          style={{
            background: '#EAB308', color: '#000',
            border: 'none', borderRadius: 12,
            padding: '10px 28px', fontSize: 14, fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Awesome
        </button>
      </div>
    </div>
  )
}
