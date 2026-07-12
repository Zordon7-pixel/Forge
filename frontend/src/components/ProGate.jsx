import { Lock } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

export default function ProGate({ children, isPro, loading, message }) {
  const navigate = useNavigate()
  const locked = !loading && !isPro

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ filter: locked ? 'blur(4px)' : 'none', pointerEvents: locked ? 'none' : 'auto' }}>
        {children}
      </div>
      {locked && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backdropFilter: 'blur(4px)',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 16,
              padding: 32,
              textAlign: 'center',
              maxWidth: 320,
            }}
          >
            <Lock size={32} color="var(--accent)" style={{ margin: '0 auto 12px' }} />
            <h3 style={{ color: 'var(--text-primary)', fontWeight: 800, fontSize: 20 }}>Forged Hybrid Pro</h3>
            <p style={{ color: 'var(--text-primary)', fontWeight: 700, marginTop: 8 }}>{message}</p>
            <p style={{ color: 'var(--text-muted)', marginTop: 8 }}>Upgrade to unlock this training insight.</p>
            <button
              onClick={() => navigate('/upgrade')}
              style={{ background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 700, padding: '12px 24px', borderRadius: 8, border: 'none', cursor: 'pointer', marginTop: 16 }}
            >
              Upgrade to Pro
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
