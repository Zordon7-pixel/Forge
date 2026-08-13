import React from 'react'
import ReactDOM from 'react-dom/client'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { ThemeProvider } from './context/ThemeContext'
import { UnitsProvider } from './context/UnitsContext'
import i18n from './i18n'
import { I18nextProvider } from 'react-i18next'
import { installChunkRecovery } from './lib/chunkRecovery'
import { hasPendingApiMutation } from './lib/api'
import { startServiceWorkerUpdates } from './lib/serviceWorkerUpdate'
import './index.css'
import 'leaflet/dist/leaflet.css'

installChunkRecovery()

if ('serviceWorker' in navigator) {
  startServiceWorkerUpdates({
    capacitorApp: CapacitorApp,
    nativeRuntime: Capacitor.isNativePlatform(),
    hasPendingMutation: hasPendingApiMutation,
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <UnitsProvider>
            <App />
        </UnitsProvider>
      </ThemeProvider>
    </I18nextProvider>
  </ErrorBoundary>
)
