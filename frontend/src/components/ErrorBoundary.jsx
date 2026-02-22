import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[FORGE Error]', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: '100vh',
            background: '#0f1117',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: 16,
            padding: 32,
            fontFamily: 'sans-serif',
          }}
        >
          <div style={{ fontSize: 48 }}>⚠️</div>
          <h1 style={{ color: '#fff', fontSize: 22, fontWeight: 700, margin: 0 }}>Something went wrong</h1>
          <p style={{ color: '#94a3b8', fontSize: 14, margin: 0, textAlign: 'center', maxWidth: 400 }}>
            FORGE ran into an unexpected error. Click below to attempt an automatic repair and reload.
          </p>
          <p
            style={{
              color: '#475569',
              fontSize: 12,
              fontFamily: 'monospace',
              background: '#1a1d2e',
              padding: '8px 16px',
              borderRadius: 8,
              maxWidth: 500,
              wordBreak: 'break-all',
            }}
          >
            {this.state.error?.message || 'Unknown error'}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: '#ef4444',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '10px 24px',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            🔧 Repair &amp; Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
