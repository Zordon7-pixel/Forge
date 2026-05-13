import React from 'react'
import { isRecoverableChunkError, recoverFromChunkError } from '../lib/chunkRecovery'

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
    recoverFromChunkError(error)
  }
  render() {
    if (this.state.hasError) {
      const recoverable = isRecoverableChunkError(this.state.error)
      return (
        <div style={{ minHeight: '100vh', background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16, padding: 32, fontFamily: 'sans-serif' }}>
          <h1 style={{ color: '#EAB308', fontSize: 20, fontWeight: 700, margin: 0 }}>{recoverable ? 'FORGE — Updating' : 'FORGE — Startup Error'}</h1>
          <p style={{ color: '#94a3b8', fontSize: 14, margin: 0, textAlign: 'center', maxWidth: 400 }}>
            {recoverable
              ? 'Forge loaded a stale app file after an update. Reload once to pull the latest version.'
              : 'Something failed during initialization. Error details:'}
          </p>
          {!recoverable && (
            <pre style={{ color: '#fca5a5', fontSize: 12, fontFamily: 'monospace', background: '#111', padding: '12px 16px', borderRadius: 8, maxWidth: 600, wordBreak: 'break-all', whiteSpace: 'pre-wrap', textAlign: 'left' }}>
              {this.state.error?.message}{'\n\n'}{this.state.error?.stack}
            </pre>
          )}
          <button
            onClick={() => {
              const url = new URL(window.location.href)
              url.searchParams.set('_forge_reload', String(Date.now()))
              window.location.replace(url.toString())
            }}
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
