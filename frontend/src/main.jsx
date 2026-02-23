import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ThemeProvider } from './context/ThemeContext'
import { UnitsProvider } from './context/UnitsContext'
import './index.css'
import 'leaflet/dist/leaflet.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <UnitsProvider>
        <App />
      </UnitsProvider>
    </ThemeProvider>
  </React.StrictMode>
)
