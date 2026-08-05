import React from 'react'
import {
  isRecoverableChunkBoundaryError,
  recoverFromChunkError,
  retryChunkRecovery,
} from '../lib/chunkRecovery'

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
    if (isRecoverableChunkBoundaryError(error)) {
      recoverFromChunkError(error, { allowGenericLoadFailure: true })
    }
  }
  render() {
    if (this.state.hasError) {
      const recoverable = isRecoverableChunkBoundaryError(this.state.error)
      return (
        <div style={{ minHeight: '100vh', background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16, padding: 32, fontFamily: 'sans-serif' }}>
          <h1 style={{ color: 'var(--accent)', fontSize: 20, fontWeight: 700, margin: 0 }}>{recoverable ? 'Forged Hybrid — Updating' : 'Forged Hybrid — Startup Error'}</h1>
          <p style={{ color: '#94a3b8', fontSize: 14, margin: 0, textAlign: 'center', maxWidth: 400 }}>
            {recoverable
              ? 'Forged Hybrid is updating after an app file changed. If the automatic refresh does not finish, reload to try again.'
              : 'Forged Hybrid could not finish starting. Reload and try again.'}
          </p>
          <button
            onClick={retryChunkRecovery}
            style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', borderRadius: 8, padding: '10px 24px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
