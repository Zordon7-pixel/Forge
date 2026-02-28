import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUnits } from '../context/UnitsContext'
import api from '../lib/api'
import { parseGarminCSV, parseStravaCSV, requestAppleHealth } from '../lib/healthImport'

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
    return { date, type, distanceMiles, durationSeconds, avgHeartRate, source: 'manual_json' }
  }).filter((row) => row.date && (row.distanceMiles > 0 || row.durationSeconds > 0))
}

export default function Settings() {
  const navigate = useNavigate()
  const { t, i18n } = useTranslation()
  const { units, setUnits } = useUnits()
  const [distanceUnit, setDistanceUnit] = useState('miles')
  const [saved, setSaved] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState('')
  const [importNotice, setImportNotice] = useState(null)
  const manualFileRef = useRef(null)

  const isIOSSafari = typeof navigator !== 'undefined'
    && /iP(ad|hone|od)/.test(navigator.userAgent)
    && /WebKit/.test(navigator.userAgent)

  const supportsAppleHealth = isIOSSafari && typeof navigator !== 'undefined' && Boolean(navigator.health)

  useEffect(() => {
    api.get('/users/settings').then(r => {
      setDistanceUnit(r.data.distance_unit || 'miles')
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!importNotice) return
    const id = setTimeout(() => setImportNotice(null), 5000)
    return () => clearTimeout(id)
  }, [importNotice])

  const save = async (unit) => {
    setDistanceUnit(unit)
    await api.put('/users/settings', { distance_unit: unit }).catch(() => {})
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

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

  const handleAppleHealthImport = async () => {
    if (!supportsAppleHealth) {
      setImportNotice({ ok: false, text: 'Apple Health import is only supported on iOS Safari with Web Health API access.' })
      return
    }

    try {
      const workouts = await requestAppleHealth()
      await runImport('/import/health', workouts)
    } catch (err) {
      setImportNotice({ ok: false, text: err?.message || 'Unable to connect to Apple Health on this device.' })
    }
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

  const card = { background: 'var(--bg-card)', borderRadius: 16, padding: '20px', marginBottom: 16, border: '1px solid var(--border-subtle)' }
  const label = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', marginBottom: 12, display: 'block' }

  return (
    <div>
      <h1 style={{ fontWeight: 900, fontSize: 24, color: 'var(--text-primary)', marginBottom: 24 }}>{t('settings.title')}</h1>

      {/* Language Selector */}
      <div style={card}>
        <span style={label}>{t('settings.language')}</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              onClick={() => i18n.changeLanguage(lang.code)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '12px 14px',
                borderRadius: 12,
                border: `2px solid ${i18n.language === lang.code ? '#EAB308' : 'var(--border-subtle)'}`,
                background: i18n.language === lang.code ? 'rgba(234, 179, 8, 0.15)' : 'var(--bg-input)',
                color: 'var(--text-primary)',
                fontWeight: 600,
                fontSize: 14,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 18 }}>{lang.flag}</span>
              <span>{lang.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Units System */}
      <div style={card}>
        <span style={label}>{t('settings.units')}</span>
        <div style={{ display: 'flex', gap: 10 }}>
          {[['imperial', t('settings.imperial')], ['metric', t('settings.metric')]].map(([val, text]) => (
            <button key={val} onClick={() => saveUnits(val)}
              style={{
                flex: 1, padding: '14px', borderRadius: 12, border: `2px solid ${units === val ? 'var(--accent)' : 'var(--border-subtle)'}`,
                background: units === val ? 'var(--accent-dim)' : 'var(--bg-input)',
                color: units === val ? 'var(--accent)' : 'var(--text-muted)',
                fontWeight: 700, fontSize: 14, cursor: 'pointer',
              }}>{text}</button>
          ))}
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
          {units === 'imperial' ? 'Miles, lbs, °F' : 'Kilometers, kg, °C'}
        </p>
        {saved && <p style={{ fontSize: 12, color: '#22c55e', marginTop: 10 }}>Saved</p>}
      </div>

      {/* Distance Units (legacy) */}
      <div style={card}>
        <span style={label}>Distance Units (Legacy)</span>
        <div style={{ display: 'flex', gap: 10 }}>
          {[['miles', 'Miles'], ['km', 'Kilometers']].map(([val, text]) => (
            <button key={val} onClick={() => save(val)}
              style={{
                flex: 1, padding: '14px', borderRadius: 12, border: `2px solid ${distanceUnit === val ? 'var(--accent)' : 'var(--border-subtle)'}`,
                background: distanceUnit === val ? 'var(--accent-dim)' : 'var(--bg-input)',
                color: distanceUnit === val ? 'var(--accent)' : 'var(--text-muted)',
                fontWeight: 700, fontSize: 14, cursor: 'pointer',
              }}>{text}</button>
          ))}
        </div>
        {saved && <p style={{ fontSize: 12, color: '#22c55e', marginTop: 10 }}>Saved</p>}
      </div>

      {/* Profile link */}
      <div style={card}>
        <span style={label}>Account</span>
        <button onClick={() => navigate('/profile')}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{t('profile.editProfile')}</span>
          <ChevronRight size={18} style={{ color: 'var(--text-muted)' }} />
        </button>
      </div>

      {/* Notifications (placeholder) */}
      <div style={card}>
        <span style={label}>Notifications</span>
        <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Push notifications — coming soon.</p>
      </div>

      {/* Connect / Import */}
      <div style={card}>
        <span style={label}>Connect / Import Data</span>

        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 14, marginBottom: 12 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Import from Apple Health</p>
          <p style={{ margin: '8px 0 10px', fontSize: 12, color: 'var(--text-muted)' }}>
            iOS Safari only. Requests access to steps, distance, heart rate, and workouts from the last 30 days.
          </p>
          <button
            onClick={handleAppleHealthImport}
            disabled={importing || !supportsAppleHealth}
            style={{
              width: '100%',
              border: '1px solid var(--border-subtle)',
              borderRadius: 10,
              padding: '10px 12px',
              fontSize: 13,
              fontWeight: 700,
              background: supportsAppleHealth ? 'var(--bg-input)' : 'rgba(148,163,184,0.1)',
              color: supportsAppleHealth ? 'var(--text-primary)' : 'var(--text-muted)',
              cursor: supportsAppleHealth ? 'pointer' : 'not-allowed',
            }}
          >
            {supportsAppleHealth ? 'Import from Apple Health' : 'Apple Health unavailable on this browser'}
          </button>
        </div>

        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 14 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Import from Garmin/Strava CSV</p>
          <p style={{ margin: '8px 0 10px', fontSize: 12, color: 'var(--text-muted)' }}>
            Export your Garmin data as CSV → upload here
          </p>
          <input ref={manualFileRef} type="file" accept=".csv,.json" onChange={handleManualImport} style={{ display: 'none' }} />
          <button
            onClick={() => manualFileRef.current?.click()}
            disabled={importing}
            style={{
              width: '100%',
              border: '1px solid var(--border-subtle)',
              borderRadius: 10,
              padding: '10px 12px',
              fontSize: 13,
              fontWeight: 700,
              background: 'var(--bg-input)',
              color: 'var(--text-primary)',
              cursor: 'pointer',
            }}
          >
            Import from Garmin/Strava CSV
          </button>
        </div>

        {importProgress && <p style={{ fontSize: 12, marginTop: 10, color: 'var(--text-muted)' }}>{importProgress}</p>}
      </div>

      {/* Data */}
      <div style={card}>
        <span style={label}>Data & Privacy</span>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          Your data lives on FORGE servers. We never sell your information.
        </p>
      </div>

      {importNotice && (
        <div style={{
          background: importNotice.ok ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.12)',
          border: `1px solid ${importNotice.ok ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)'}`,
          color: importNotice.ok ? '#86efac' : '#fca5a5',
          borderRadius: 12,
          padding: '10px 12px',
          fontSize: 13,
          marginBottom: 16,
        }}>
          {importNotice.text}
        </div>
      )}

      {/* App version */}
      <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', opacity: 0.5, marginTop: 24 }}>
        FORGE v1.0 · Built to adapt.
      </p>
    </div>
  )
}
