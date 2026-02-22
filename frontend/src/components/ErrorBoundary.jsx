import React from 'react'

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    console.error('[FORGE Error]', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: '100vh', background: 'var(--bg-base)', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16, padding: 32, fontFamily: 'sans-serif' }}>
          <div style={{ fontSize: 48, color: 'var(--accent)' }}>!</div>
          <h1 style={{ color: 'var(--text-primary)', fontSize: 22, fontWeight: 700, margin: 0 }}>Something went wrong</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 14, margin: 0, textAlign: 'center', maxWidth: 400 }}>FORGE ran into an unexpected error. Click below to attempt an automatic repair and reload.</p>
          <p style={{ color: 'var(--text-muted)', opacity: 0.7, fontSize: 12, fontFamily: 'monospace', background: 'var(--bg-card)', padding: '8px 16px', borderRadius: 8, maxWidth: 500, wordBreak: 'break-all' }}>
            {this.state.error?.message || 'Unknown error'}
          </p>
          <button onClick={() => window.location.reload()} style={{ background: 'var(--accent)', color: 'black', border: 'none', borderRadius: 8, padding: '10px 24px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
            Repair & Reload
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
