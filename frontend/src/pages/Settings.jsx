import { useCallback, useEffect, useRef, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { useNavigate } from 'react-router'
import { ChevronRight, Download, Moon, RefreshCw, Shield, Sun, Trash2, Watch } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUnits } from '../context/UnitsContext'
import { useTheme } from '../context/ThemeContext'
import api from '../lib/api'
import { parseGarminCSV, parseStravaCSV } from '../lib/healthImport'
import { formatFreshness, GARMIN_BETA_PRESENTATION } from '../lib/deviceSourcePresentation'
import WatchDeliveryService from '../services/WatchDeliveryService'
import SmartStartMotionService from '../services/SmartStartMotionService'
import { athleteWatchAvailabilityMessage, isInternalWatchDiagnostic } from '../services/watchWorkoutAvailability'
import TestFlightDebugPanel from '../components/TestFlightDebugPanel'
import appConfig from '../../app.json'

const LANGUAGES = [
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'es', name: 'Español', flag: '🇪🇸' },
  { code: 'pt-BR', name: 'Português (BR)', flag: '🇧🇷' },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'ja', name: '日本語', flag: '🇯🇵' },
]

const KM_TO_MILES = 0.621371

function parseDuration(value) {
  const raw = String(value || '').trim()
  if (!raw) return 0
  if (/^\d+$/.test(raw)) return Number(raw)
  if (/^\d+:\d{1,2}(:\d{1,2})?$/.test(raw)) {
    const parts = raw.split(':').map(Number)
    if (parts.length === 2) return (parts[0] * 60) + parts[1]
    if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2]
  }
  return 0
}

function normalizeDate(value) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

function normalizeJsonRows(parsed) {
  const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.workouts) ? parsed.workouts : [])
  return rows.map((row) => {
    const date = normalizeDate(row.date || row.startDate || row['Activity Date'])
    const type = row.type || row.activityType || row['Activity Type'] || 'run'
    const unit = String(row.unit || row.distanceUnit || '').toLowerCase()
    const rawDistance = Number(row.distance || row.distance_km || row.distanceKm || row.distanceMiles || 0)
    const distanceMiles = row.distanceMiles
      ? Number(row.distanceMiles)
      : Number((rawDistance * (unit === 'km' || row.distance_km || row.distanceKm ? KM_TO_MILES : 1)).toFixed(3))
    const durationSeconds = Number(row.durationSeconds || row.duration_seconds || parseDuration(row.duration || row['Elapsed Time']) || 0)
    const avgHeartRate = Number(row.avgHeartRate || row.avg_heart_rate || row['Average Heart Rate'] || 0) || null
    return { ...row, date, type, distanceMiles, durationSeconds, avgHeartRate, source: row.source || 'manual_json' }
  }).filter((row) => row.date && (row.distanceMiles > 0 || row.durationSeconds > 0))
}

export default function Settings() {
  const navigate = useNavigate()
  const { t, i18n } = useTranslation()
  const { units, setUnits } = useUnits()
  const { theme, setTheme } = useTheme()
  const [saved, setSaved] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState('')
  const [importNotice, setImportNotice] = useState(null)
  const [deviceStatuses, setDeviceStatuses] = useState({})
  const [deviceSyncing, setDeviceSyncing] = useState({})
  const [deviceConnecting, setDeviceConnecting] = useState({})
  const [refreshingDevices, setRefreshingDevices] = useState(false)
  const [deviceNotice, setDeviceNotice] = useState(null)
  const [privacyNotice, setPrivacyNotice] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deletePassword, setDeletePassword] = useState('')
  const [showDeleteAccount, setShowDeleteAccount] = useState(false)
  const [debugTapCount, setDebugTapCount] = useState(0)
  const [showDebugPanel, setShowDebugPanel] = useState(false)
  const [watchDelivery, setWatchDelivery] = useState({ checked: false, canAutoSend: false, reason: '', providers: [] })
  const [smartStartEnabled, setSmartStartEnabled] = useState(() => SmartStartMotionService.isEnabled())
  const [smartStartStatus, setSmartStartStatus] = useState({ checked: false, available: false, authorization: 'unavailable', reason: '' })
  const [smartStartBusy, setSmartStartBusy] = useState(false)
  const manualFileRef = useRef(null)
  const debugTapTimerRef = useRef(null)
  const deviceStatusRequestRef = useRef(0)
  const deviceConnectionPollRef = useRef(null)
  const pendingDeviceRef = useRef('')

  const loadDeviceStatuses = useCallback(async ({ announceDevice = '' } = {}) => {
    const requestId = ++deviceStatusRequestRef.current
    const devices = ['strava', 'oura']
    const entries = await Promise.all(devices.map(async (device) => {
      try {
        const response = await api.get(`/${device}/status`, { params: { fresh: Date.now() } })
        return [device, { ...(response.data || { connected: false }), statusChecked: true, statusUnavailable: false }]
      } catch (error) {
        console.error(`[settings/${device}-status] refresh failed:`, error?.message)
        return [device, { statusChecked: true, statusUnavailable: true }]
      }
    }))

    if (requestId !== deviceStatusRequestRef.current) return null
    const freshStatuses = Object.fromEntries(entries.filter(([, value]) => !value.statusUnavailable))
    setDeviceStatuses((current) => {
      const next = { ...current }
      entries.forEach(([device, value]) => {
        next[device] = value.statusUnavailable
          ? { ...current[device], available: false, statusChecked: true, statusUnavailable: true }
          : value
      })
      return next
    })

    if (announceDevice && freshStatuses[announceDevice]?.connected) {
      pendingDeviceRef.current = ''
      clearTimeout(deviceConnectionPollRef.current)
      deviceConnectionPollRef.current = null
      setDeviceNotice({ ok: true, text: `${announceDevice.toUpperCase()} connected. You can sync now.` })
    }
    return freshStatuses
  }, [])

  const startDeviceConnectionPoll = useCallback((device) => {
    pendingDeviceRef.current = device
    clearTimeout(deviceConnectionPollRef.current)
    let attempts = 0

    const poll = async () => {
      attempts += 1
      const statuses = await loadDeviceStatuses({ announceDevice: device })
      if (statuses?.[device]?.connected || attempts >= 60 || pendingDeviceRef.current !== device) return
      deviceConnectionPollRef.current = window.setTimeout(poll, 2000)
    }

    deviceConnectionPollRef.current = window.setTimeout(poll, 2000)
  }, [loadDeviceStatuses])

  useEffect(() => {
    loadDeviceStatuses()
    WatchDeliveryService.getAvailability()
      .then((result) => {
        if (!result?.canAutoSend && isInternalWatchDiagnostic(result?.reason)) {
          console.error('[settings/watch-delivery] unavailable:', result.reason)
        }
        setWatchDelivery({ checked: true, ...result })
      })
      .catch((err) => setWatchDelivery({
        checked: true,
        canAutoSend: false,
        reason: err?.message || 'Watch delivery is unavailable.',
        providers: WatchDeliveryService.getProviders(),
      }))
  }, [loadDeviceStatuses])

  useEffect(() => {
    let active = true
    SmartStartMotionService.getStatus()
      .then((status) => {
        if (active) setSmartStartStatus({ checked: true, ...status })
      })
      .catch((error) => {
        console.warn('[settings/smart-start] status check failed:', error?.message || error)
        if (active) setSmartStartStatus({ checked: true, available: false, authorization: 'unavailable', reason: 'native_error' })
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    let cancelled = false
    const listenerHandles = []
    const refresh = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        loadDeviceStatuses({ announceDevice: pendingDeviceRef.current })
      }
    }
    window.addEventListener('focus', refresh)
    window.addEventListener('pageshow', refresh)
    document.addEventListener('visibilitychange', refresh)

    try {
      const appStateHandle = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) refresh()
      })
      const resumeHandle = CapacitorApp.addListener('resume', refresh)
      Promise.all([appStateHandle, resumeHandle])
        .then((handles) => {
          if (cancelled) handles.forEach((handle) => handle?.remove?.())
          else listenerHandles.push(...handles)
        })
        .catch((error) => console.warn('[settings/devices] app listener setup failed:', error?.message))
    } catch (error) {
      console.warn('[settings/devices] app listener setup failed:', error?.message)
    }

    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
      window.removeEventListener('pageshow', refresh)
      document.removeEventListener('visibilitychange', refresh)
      listenerHandles.forEach((handle) => handle?.remove?.())
    }
  }, [loadDeviceStatuses])

  useEffect(() => {
    if (!importNotice) return
    const id = setTimeout(() => setImportNotice(null), 5000)
    return () => clearTimeout(id)
  }, [importNotice])

  useEffect(() => {
    if (!deviceNotice) return
    const id = setTimeout(() => setDeviceNotice(null), 6000)
    return () => clearTimeout(id)
  }, [deviceNotice])

  useEffect(() => {
    if (!privacyNotice) return
    const id = setTimeout(() => setPrivacyNotice(null), 6000)
    return () => clearTimeout(id)
  }, [privacyNotice])

  useEffect(() => () => {
    clearTimeout(debugTapTimerRef.current)
    clearTimeout(deviceConnectionPollRef.current)
  }, [])

  const saveUnits = async (newUnits) => {
    await setUnits(newUnits)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const runImport = async (endpoint, workouts) => {
    if (!workouts.length) {
      setImportNotice({ ok: false, text: 'No workouts found in that export.' })
      return
    }

    setImporting(true)
    setImportProgress(`Importing ${workouts.length} workouts...`)
    try {
      const { data } = await api.post(endpoint, { workouts })
      const imported = Number(data?.imported || 0)
      const skipped = Number(data?.skipped || 0)
      setImportNotice({ ok: true, text: `✅ ${imported} workouts imported, ${skipped} skipped (already existed)` })
    } catch (err) {
      setImportNotice({ ok: false, text: err?.response?.data?.error || 'Import failed. Please try another file.' })
    } finally {
      setImportProgress('')
      setImporting(false)
    }
  }

  const handleVersionTap = () => {
    clearTimeout(debugTapTimerRef.current)
    setDebugTapCount((count) => {
      const next = count + 1
      if (next >= 7) {
        setShowDebugPanel(true)
        return 0
      }
      debugTapTimerRef.current = setTimeout(() => setDebugTapCount(0), 1800)
      return next
    })
  }

  const handleManualImport = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    try {
      const content = await file.text()
      const name = file.name.toLowerCase()
      let workouts = []

      if (name.endsWith('.csv')) {
        const header = content.split(/\r?\n/)[0] || ''
        workouts = /Activity Date|Activity Type|Elapsed Time/i.test(header)
          ? parseStravaCSV(content)
          : parseGarminCSV(content)
      } else if (name.endsWith('.json')) {
        workouts = normalizeJsonRows(JSON.parse(content))
      } else {
        setImportNotice({ ok: false, text: 'Unsupported file type. Please upload CSV or JSON.' })
        return
      }

      await runImport('/import/workouts', workouts)
    } catch (err) {
      setImportNotice({ ok: false, text: 'Could not parse file. Expected Garmin/Strava CSV or workout JSON.' })
    }
  }

  const handleDeviceDisconnect = async (device) => {
    try {
      await api.delete(`/${device}/disconnect`)
      setDeviceStatuses((prev) => ({ ...prev, [device]: { connected: false } }))
      setPrivacyNotice({ ok: true, text: `${device.toUpperCase()} disconnected.` })
    } catch (err) {
      setPrivacyNotice({ ok: false, text: err?.response?.data?.error || `Could not disconnect ${device}.` })
    }
  }

  const handleDeviceConnect = async (device) => {
    setDeviceConnecting((prev) => ({ ...prev, [device]: true }))
    setDeviceNotice({ ok: true, text: `Opening ${device.toUpperCase()} connection. Finish there, then return to Forged Hybrid.` })
    try {
      const { data } = await api.get(`/${device}/auth`, { params: { format: 'json' } })
      if (data?.url) {
        const opened = window.open(data.url, '_blank', 'noopener,noreferrer')
        if (!opened) window.location.href = data.url
        startDeviceConnectionPoll(device)
        return
      }
      setDeviceNotice({ ok: false, text: `Could not start ${device.toUpperCase()} connection.` })
    } catch (err) {
      setDeviceNotice({ ok: false, text: err?.response?.data?.error || `Could not start ${device.toUpperCase()} connection.` })
    } finally {
      setDeviceConnecting((prev) => ({ ...prev, [device]: false }))
    }
  }

  const handleDeviceSync = async (device) => {
    setDeviceSyncing((prev) => ({ ...prev, [device]: true }))
    try {
      const { data } = await api.post(`/${device}/sync`)
      await loadDeviceStatuses()
      setPrivacyNotice({ ok: true, text: `${device.toUpperCase()} synced ${Number(data?.synced ?? data?.imported ?? 0)} records.` })
    } catch (err) {
      setPrivacyNotice({ ok: false, text: err?.response?.data?.error || `Could not sync ${device.toUpperCase()}.` })
    } finally {
      setDeviceSyncing((prev) => ({ ...prev, [device]: false }))
    }
  }

  const handleDeviceStatusRefresh = async () => {
    setRefreshingDevices(true)
    try {
      const statuses = await loadDeviceStatuses({ announceDevice: pendingDeviceRef.current })
      const refreshed = statuses && Object.keys(statuses).length > 0
      setDeviceNotice(refreshed
        ? { ok: true, text: 'Device connection status refreshed.' }
        : { ok: false, text: 'Could not refresh device status. Try again.' })
    } catch (error) {
      console.error('[settings/devices] manual refresh failed:', error?.message || error)
      setDeviceNotice({ ok: false, text: 'Could not refresh device status. Try again.' })
    } finally {
      setRefreshingDevices(false)
    }
  }

  const handleExportData = async () => {
    setExporting(true)
    try {
      const { data } = await api.get('/auth/me/export')
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `forge-export-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      setPrivacyNotice({ ok: true, text: 'Data export downloaded.' })
    } catch (err) {
      setPrivacyNotice({ ok: false, text: err?.response?.data?.error || 'Could not export data.' })
    } finally {
      setExporting(false)
    }
  }

  const handleSmartStartToggle = async () => {
    if (smartStartEnabled) {
      SmartStartMotionService.setEnabled(false)
      setSmartStartEnabled(false)
      setPrivacyNotice({ ok: true, text: 'Missed-start detection is off. Manual Start Run remains available.' })
      return
    }

    setSmartStartBusy(true)
    try {
      const result = await SmartStartMotionService.requestAuthorization()
      setSmartStartStatus((current) => ({ checked: true, ...current, ...result }))
      if (result.ok && result.authorization === 'authorized') {
        SmartStartMotionService.setEnabled(true)
        setSmartStartEnabled(true)
        setPrivacyNotice({ ok: true, text: 'Missed-start detection is on. Recent motion history will be checked when Forged Hybrid is in the foreground.' })
      } else {
        SmartStartMotionService.setEnabled(false)
        setSmartStartEnabled(false)
        const denied = result.authorization === 'denied' || result.authorization === 'restricted'
        setPrivacyNotice({
          ok: false,
          text: denied
            ? 'Motion & Fitness access is off. Manual Start Run still works; use the iPhone Settings path below to change access.'
            : 'Missed-start detection requires Forged Hybrid build 20 on a supported iPhone. Manual Start Run still works.',
        })
      }
    } catch (error) {
      console.warn('[settings/smart-start] opt-in failed:', error?.message || error)
      SmartStartMotionService.setEnabled(false)
      setSmartStartEnabled(false)
      setPrivacyNotice({ ok: false, text: 'Motion opt-in could not be completed. Manual Start Run still works.' })
    } finally {
      setSmartStartBusy(false)
    }
  }

  const openSmartStartSettings = async () => {
    try {
      const opened = await SmartStartMotionService.openSettings()
      if (!opened) setPrivacyNotice({ ok: false, text: 'Open iPhone Settings > Privacy & Security > Motion & Fitness, then allow Forged Hybrid.' })
    } catch (error) {
      console.warn('[settings/smart-start] Settings recovery failed:', error?.message || error)
      setPrivacyNotice({ ok: false, text: 'Open iPhone Settings > Privacy & Security > Motion & Fitness, then allow Forged Hybrid.' })
    }
  }

  const handleDeleteAccount = async () => {
    if (deleteConfirm !== 'DELETE') {
      setPrivacyNotice({ ok: false, text: 'Type DELETE to confirm account deletion.' })
      return
    }
    setDeleting(true)
    try {
      await api.delete('/auth/account', { data: { confirm: deleteConfirm, password: deletePassword } })
      localStorage.clear()
      navigate('/login')
    } catch (err) {
      setPrivacyNotice({ ok: false, text: err?.response?.data?.error || 'Could not delete account.' })
      setDeleting(false)
    }
  }

  const card = { background: 'var(--bg-card)', borderRadius: 16, padding: '20px', border: '1px solid var(--border-subtle)' }
  const section = { marginBottom: 18 }
  const sectionTitle = { fontSize: 18, fontWeight: 900, color: 'var(--text-primary)', margin: '0 0 10px' }
  const sectionGrid = { display: 'grid', gap: 12 }
  const label = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', marginBottom: 12, display: 'block' }
  const watchProviderPill = (provider) => {
    const active = provider.id === 'apple-watch' && watchDelivery.canAutoSend
    const labelText = active ? 'Ready' : provider.status === 'planned' ? 'Planned' : provider.status === 'available' ? 'iPhone app' : 'API access needed'
    return (
      <div key={provider.id} style={{
        border: '1px solid var(--border-subtle)',
        borderRadius: 12,
        padding: '10px 11px',
        background: active ? 'rgba(34,197,94,0.12)' : 'var(--bg-input)',
        display: 'grid',
        gap: 5,
        minWidth: 0,
        overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap', minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 900, color: 'var(--text-primary)', minWidth: 0, overflowWrap: 'anywhere' }}>{provider.name}</span>
          <span style={{ fontSize: 10, fontWeight: 900, color: active ? 'var(--success)' : 'var(--text-muted)', textTransform: 'uppercase', overflowWrap: 'anywhere' }}>{labelText}</span>
        </div>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.35, overflowWrap: 'anywhere' }}>{provider.delivery}</p>
      </div>
    )
  }
  const deviceRows = [
    {
      key: 'strava',
      name: 'Strava',
      connected: Boolean(deviceStatuses.strava?.connected),
      detail: deviceStatuses.strava?.athlete_name || '',
      lastSync: deviceStatuses.strava?.last_sync,
      available: deviceStatuses.strava?.available === true,
      statusChecked: Boolean(deviceStatuses.strava?.statusChecked),
      statusUnavailable: Boolean(deviceStatuses.strava?.statusUnavailable),
      connect: () => handleDeviceConnect('strava'),
      connecting: Boolean(deviceConnecting.strava),
      sync: () => handleDeviceSync('strava'),
      revoke: () => handleDeviceDisconnect('strava'),
    },
    {
      key: 'oura',
      name: 'Oura',
      connected: Boolean(deviceStatuses.oura?.connected),
      detail: deviceStatuses.oura?.displayName || '',
      lastSync: deviceStatuses.oura?.lastSync,
      available: deviceStatuses.oura?.available === true,
      statusChecked: Boolean(deviceStatuses.oura?.statusChecked),
      statusUnavailable: Boolean(deviceStatuses.oura?.statusUnavailable),
      connect: () => handleDeviceConnect('oura'),
      connecting: Boolean(deviceConnecting.oura),
      sync: () => handleDeviceSync('oura'),
      revoke: () => handleDeviceDisconnect('oura'),
    },
  ]

  return (
    <div>
      <h1 style={{ fontWeight: 900, fontSize: 24, color: 'var(--text-primary)', marginBottom: 24 }}>{t('settings.title')}</h1>

      <section style={section}>
        <h2 style={sectionTitle}>Preferences</h2>
        <div style={sectionGrid}>
          <div style={card}>
            <span style={label}>{t('settings.appearance')}</span>
            <div style={{ display: 'flex', gap: 10 }}>
              {[['dark', Moon], ['light', Sun]].map(([val, Icon]) => (
                <button key={val} onClick={() => setTheme(val)}
                  style={{ flex: 1, padding: '14px', borderRadius: 12, border: `2px solid ${theme === val ? 'var(--accent)' : 'var(--border-subtle)'}`, background: theme === val ? 'var(--accent-dim)' : 'var(--bg-input)', color: theme === val ? 'var(--accent)' : 'var(--text-muted)', fontWeight: 700, fontSize: 15, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                >
                  <Icon size={16} />
                  {t(`settings.${val}`)}
                </button>
              ))}
            </div>
          </div>

          <div style={card}>
            <span style={label}>{t('settings.language')}</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              {LANGUAGES.map((lang) => (
                <button
                  key={lang.code}
                  onClick={() => i18n.changeLanguage(lang.code)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderRadius: 12, border: `2px solid ${i18n.language === lang.code ? 'var(--accent)' : 'var(--border-subtle)'}`, background: i18n.language === lang.code ? 'var(--accent-dim)' : 'var(--bg-input)', color: 'var(--text-primary)', fontWeight: 600, fontSize: 14, cursor: 'pointer', textAlign: 'left' }}
                >
                  <span style={{ fontSize: 18 }}>{lang.flag}</span>
                  <span>{lang.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div style={card}>
            <span style={label}>{t('settings.units')}</span>
            <div style={{ display: 'flex', gap: 10 }}>
              {[['imperial', t('settings.imperial')], ['metric', t('settings.metric')]].map(([val, text]) => (
                <button key={val} onClick={() => saveUnits(val)}
                  style={{ flex: 1, padding: '14px', borderRadius: 12, border: `2px solid ${units === val ? 'var(--accent)' : 'var(--border-subtle)'}`, background: units === val ? 'var(--accent-dim)' : 'var(--bg-input)', color: units === val ? 'var(--accent)' : 'var(--text-muted)', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
                >
                  {text}
                </button>
              ))}
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
              {units === 'imperial' ? 'Miles, lbs, °F' : 'Kilometers, kg, °C'}
            </p>
            {saved && <p style={{ fontSize: 12, color: 'var(--success)', marginTop: 10 }}>Saved</p>}
          </div>
        </div>
      </section>

      <section style={section}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
          <h2 style={{ ...sectionTitle, margin: 0 }}>Devices</h2>
          <button
            type="button"
            onClick={handleDeviceStatusRefresh}
            disabled={refreshingDevices}
            aria-label="Refresh device status"
            title="Refresh device status"
            style={{ width: 40, height: 40, display: 'grid', placeItems: 'center', borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', opacity: refreshingDevices ? 0.6 : 1 }}
          >
            <RefreshCw size={17} aria-hidden="true" className={refreshingDevices ? 'animate-spin' : ''} />
          </button>
        </div>
        {deviceNotice && (
          <div style={{ marginBottom: 10, borderRadius: 10, padding: '9px 10px', fontSize: 12, border: `1px solid ${deviceNotice.ok ? 'rgba(34,197,94,0.35)' : 'var(--danger-dim)'}`, color: deviceNotice.ok ? 'var(--success)' : 'var(--danger)', background: deviceNotice.ok ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.1)' }}>
            {deviceNotice.text}
          </div>
        )}
        <div style={sectionGrid}>
          <div style={card}>
            <span style={label}>Watch Delivery</span>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
              <div>
                <p style={{ margin: 0, fontSize: 15, fontWeight: 900, color: 'var(--text-primary)' }}>One Send to Watch flow</p>
                <p style={{ margin: '5px 0 0', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55 }}>
                  Forged Hybrid builds provider-neutral structured workouts. Apple Watch is the direct path; other provider adapters are not available in this beta.
                </p>
              </div>
              <Shield size={18} style={{ color: watchDelivery.canAutoSend ? 'var(--success)' : 'var(--text-muted)', flexShrink: 0 }} />
            </div>
            <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', minWidth: 0 }}>
              {(watchDelivery.providers?.length ? watchDelivery.providers : WatchDeliveryService.getProviders())
                .filter((provider) => provider.id !== 'garmin')
                .map(watchProviderPill)}
            </div>
            {watchDelivery.checked && watchDelivery.reason && (
              <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>{athleteWatchAvailabilityMessage(watchDelivery.reason)}</p>
            )}
          </div>

          <div data-device-provider="garmin" style={card}>
            <span style={label}>{GARMIN_BETA_PRESENTATION.label}</span>
            <div style={{ display: 'grid', gap: 10 }}>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Watch size={15} />
                {GARMIN_BETA_PRESENTATION.status}
              </p>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6 }}>
                {GARMIN_BETA_PRESENTATION.detail}
              </p>
            </div>
          </div>

          {deviceRows.map((device) => (
            <div key={device.key} style={card}>
              <span style={label}>{device.name}</span>
              <div style={{ display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: 'var(--text-primary)' }}>{device.detail || device.name}</p>
                    <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>Status: {device.connected ? 'Connected' : 'Not connected'}</p>
                    <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>{formatFreshness(device.lastSync) || 'No sync yet'}</p>
                  </div>
                  <Shield size={18} style={{ color: device.connected ? 'var(--success)' : 'var(--text-muted)', flexShrink: 0 }} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: device.connected ? '1fr 1fr' : '1fr', gap: 8 }}>
                  {!device.connected ? (
                    <button type="button" onClick={device.connect} disabled={device.connecting || !device.available} style={{ border: '1px solid var(--accent)', borderRadius: 10, padding: '10px 12px', background: device.available ? 'var(--accent)' : 'var(--bg-input)', color: device.available ? '#111111' : 'var(--text-muted)', fontSize: 13, fontWeight: 800, cursor: device.connecting ? 'wait' : device.available ? 'pointer' : 'not-allowed', opacity: device.connecting ? 0.7 : 1 }}>
                      {!device.statusChecked ? `Checking ${device.name}...` : device.statusUnavailable ? `${device.name} status unavailable` : !device.available ? `${device.name} connection coming soon` : device.connecting ? `Opening ${device.name}...` : `Connect ${device.name}`}
                    </button>
                  ) : (
                    <>
                      <button type="button" onClick={device.sync} disabled={Boolean(deviceSyncing[device.key])} style={{ border: '1px solid var(--accent)', borderRadius: 10, padding: '10px 12px', background: 'var(--accent)', color: '#111111', fontSize: 13, fontWeight: 800, cursor: 'pointer', opacity: deviceSyncing[device.key] ? 0.6 : 1 }}>
                        {deviceSyncing[device.key] ? 'Syncing...' : 'Sync'}
                      </button>
                      <button type="button" onClick={device.revoke} style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '10px 12px', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                        Revoke
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}

          <div style={card}>
            <span style={label}>File Import</span>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>Upload Garmin or Strava CSV, or structured workout JSON. Supported route, elevation, heart-rate, cadence, power, running-dynamics, respiration, run/walk, and performance fields are preserved when present.</p>
            <input ref={manualFileRef} type="file" accept=".csv,.json" onChange={handleManualImport} style={{ display: 'none' }} />
            <button onClick={() => manualFileRef.current?.click()} disabled={importing} style={{ width: '100%', marginTop: 12, border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '10px 12px', fontSize: 13, fontWeight: 700, background: 'var(--bg-input)', color: 'var(--text-primary)', cursor: 'pointer', opacity: importing ? 0.7 : 1 }}>
              {importing ? 'Importing...' : 'Import File'}
            </button>
            {importProgress && <p style={{ fontSize: 12, marginTop: 10, color: 'var(--text-muted)' }}>{importProgress}</p>}
          </div>
        </div>
      </section>

      <section style={section}>
        <h2 style={sectionTitle}>Privacy</h2>
        <div style={sectionGrid}>
          <div style={card}>
            <span style={label}>Smart Missed-Start Detection</span>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 15, fontWeight: 900, color: 'var(--text-primary)' }}>Recover a probable run</p>
                <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55 }}>
                  Off by default. After you opt in, Forged Hybrid checks recent Motion &amp; Fitness history while the app is in the foreground. It does not start all-day GPS or reconstruct your route, so battery impact stays low.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={smartStartEnabled}
                aria-label="Smart missed-start detection"
                onClick={handleSmartStartToggle}
                disabled={smartStartBusy || (!smartStartEnabled && smartStartStatus.checked && !smartStartStatus.available)}
                style={{ minWidth: 70, borderRadius: 999, padding: '9px 12px', border: `1px solid ${smartStartEnabled ? 'var(--accent)' : 'var(--border-subtle)'}`, background: smartStartEnabled ? 'var(--accent)' : 'var(--bg-input)', color: smartStartEnabled ? 'var(--on-accent)' : 'var(--text-muted)', fontSize: 12, fontWeight: 900, cursor: smartStartBusy ? 'wait' : 'pointer', opacity: smartStartBusy ? 0.65 : 1 }}
              >
                {smartStartBusy ? 'Checking' : smartStartEnabled ? 'On' : 'Off'}
              </button>
            </div>
            {smartStartStatus.checked && !smartStartStatus.available && (
              <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                Motion recovery is unavailable in this browser or app build. Manual Start Run is unchanged.
              </p>
            )}
            {['denied', 'restricted'].includes(smartStartStatus.authorization) && (
              <div style={{ marginTop: 12, borderRadius: 12, padding: 12, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  Manual Start Run remains fully available. To recover access, open iPhone Settings &gt; Privacy &amp; Security &gt; Motion &amp; Fitness and allow Forged Hybrid.
                </p>
                <button type="button" onClick={openSmartStartSettings} style={{ width: '100%', marginTop: 10, border: '1px solid var(--accent)', borderRadius: 10, padding: '10px 12px', background: 'var(--accent-dim)', color: 'var(--accent)', fontSize: 13, fontWeight: 800 }}>
                  Open iPhone Settings
                </button>
              </div>
            )}
          </div>

          <div style={card}>
            <span style={label}>Data Export</span>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, marginTop: 0 }}>Download your account, training, device, and community data as JSON.</p>
            <button type="button" onClick={handleExportData} disabled={exporting} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '11px 12px', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: exporting ? 0.7 : 1 }}>
              <Download size={14} />
              {exporting ? 'Exporting...' : 'Export My Data'}
            </button>
          </div>
        </div>
      </section>

      <section style={section}>
        <h2 style={sectionTitle}>Account</h2>
        <div style={sectionGrid}>
          <div style={card}>
            <span style={label}>Profile</span>
            <button onClick={() => navigate('/profile')} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{t('profile.editProfile')}</span>
              <ChevronRight size={18} style={{ color: 'var(--text-muted)' }} />
            </button>
          </div>

          <div style={card}>
            <span style={label}>Delete Account</span>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, marginTop: 0 }}>Permanently delete your account and training history.</p>
            <button type="button" onClick={() => setShowDeleteAccount((value) => !value)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, border: '1px solid rgba(239,68,68,0.4)', borderRadius: 12, padding: '11px 12px', background: 'rgba(239,68,68,0.08)', color: 'var(--danger)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              <Trash2 size={14} />
              Delete Account
            </button>
            {showDeleteAccount && (
              <div style={{ border: '1px solid var(--danger-dim)', borderRadius: 12, padding: 12, background: 'rgba(239,68,68,0.08)', marginTop: 10 }}>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--danger)' }}>Type DELETE and confirm your password to continue.</p>
                <input value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)} placeholder="DELETE" aria-label="Delete account confirmation" style={{ width: '100%', marginTop: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--danger-dim)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} />
                <input type="password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} placeholder="Current password" aria-label="Current password" autoComplete="current-password" style={{ width: '100%', marginTop: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--danger-dim)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} />
                <button type="button" onClick={handleDeleteAccount} disabled={deleting} style={{ width: '100%', marginTop: 10, border: 'none', borderRadius: 10, padding: '10px 12px', background: 'var(--danger)', color: '#fff', fontWeight: 800, cursor: 'pointer', opacity: deleting ? 0.7 : 1 }}>
                  {deleting ? 'Deleting...' : 'Permanently Delete Account'}
                </button>
              </div>
            )}
          </div>
        </div>
      </section>

      {privacyNotice && (
        <div style={{ marginBottom: 16, borderRadius: 10, padding: '9px 10px', fontSize: 12, border: `1px solid ${privacyNotice.ok ? 'rgba(34,197,94,0.35)' : 'var(--danger-dim)'}`, color: privacyNotice.ok ? 'var(--success)' : 'var(--danger)', background: privacyNotice.ok ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.1)' }}>
          {privacyNotice.text}
        </div>
      )}

      {importNotice && (
        <div style={{
          background: importNotice.ok ? 'rgba(34,197,94,0.15)' : 'var(--danger-dim)',
          border: `1px solid ${importNotice.ok ? 'rgba(34,197,94,0.35)' : 'var(--danger-dim)'}`,
          color: importNotice.ok ? 'var(--success)' : 'var(--danger)',
          borderRadius: 12,
          padding: '10px 12px',
          fontSize: 13,
          marginBottom: 16,
        }}>
          {importNotice.text}
        </div>
      )}

      {/* App version */}
      <button type="button" onClick={handleVersionTap} style={{ display: 'block', width: '100%', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', opacity: 0.5, marginTop: 24, background: 'none', border: 'none', padding: 0, cursor: 'default' }} aria-label="App version">
        Forged Hybrid v{appConfig.expo?.version || '1.0'} · Built to adapt.
      </button>

      <TestFlightDebugPanel open={showDebugPanel} onClose={() => setShowDebugPanel(false)} />
    </div>
  )
}
