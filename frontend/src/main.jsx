import React, { Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { ThemeProvider } from './context/ThemeContext'
import { UnitsProvider } from './context/UnitsContext'
import i18n from './i18n'
import { I18nextProvider } from 'react-i18next'
import './index.css'
import 'leaflet/dist/leaflet.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <UnitsProvider>
          <Suspense fallback={<div style={{ background: '#0a0a0a', height: '100vh' }} />}>
            <App />
          </Suspense>
        </UnitsProvider>
      </ThemeProvider>
    </I18nextProvider>
  </ErrorBoundary>
)
