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
        <div style={{ minHeight: '100vh', background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16, padding: 32, fontFamily: 'sans-serif' }}>
          <h1 style={{ color: '#EAB308', fontSize: 20, fontWeight: 700, margin: 0 }}>FORGE — Startup Error</h1>
          <p style={{ color: '#94a3b8', fontSize: 14, margin: 0, textAlign: 'center', maxWidth: 400 }}>
            Something failed during initialization. Error details:
          </p>
          <pre style={{ color: '#fca5a5', fontSize: 12, fontFamily: 'monospace', background: '#111', padding: '12px 16px', borderRadius: 8, maxWidth: 600, wordBreak: 'break-all', whiteSpace: 'pre-wrap', textAlign: 'left' }}>
            {this.state.error?.message}{'\n\n'}{this.state.error?.stack}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{ background: '#EAB308', color: '#000', border: 'none', borderRadius: 8, padding: '10px 24px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
