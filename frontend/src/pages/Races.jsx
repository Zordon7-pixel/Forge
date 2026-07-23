import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProContext } from '../context/ProContext'
import DurationPicker from '../components/DurationPicker'
import api from '../lib/api'
import { RACE_DISTANCE_OPTIONS, STANDARD_RACE_DISTANCES } from '../lib/raceDistances'

function daysTo(date) {
  const ms = new Date(`${date}T12:00:00`).getTime() - Date.now()
  return Math.max(0, Math.ceil(ms / 86400000))
}

function todayDateKey() {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

function formatRaceDate(date) {
  if (!date) return ''
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function parseElevationSeries(courseProfileJson) {
  if (!courseProfileJson) return []

  try {
    const parsed = typeof courseProfileJson === 'string' ? JSON.parse(courseProfileJson) : courseProfileJson
    const values = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.distanceSamples)
        ? parsed.distanceSamples.map((sample) => sample?.elevationFt)
        : []

    return values
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
  } catch {
    return []
  }
}

function ElevationSparkline({ values }) {
  if (!values.length) return null

  const width = 80
  const height = 20
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const xStep = values.length > 1 ? width / (values.length - 1) : width
  const points = values
    .map((value, index) => {
      const x = values.length > 1 ? index * xStep : width / 2
      const y = height - ((value - min) / range) * (height - 4) - 2
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="shrink-0">
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
    </svg>
  )
}

function CourseStats({ race }) {
  const intelligence = race?.course_intelligence
  const facts = intelligence?.trusted ? (intelligence.facts || {}) : {}
  const elevationGain = facts.elevationGainFt
  const maxAltitude = facts.maxAltitudeFt
  const terrain = facts.terrain
  const distanceMiles = Number(race?.distance_miles)
  const gainNumber = Number(elevationGain)
  const hasElevationGain = elevationGain !== null && elevationGain !== undefined && Number.isFinite(gainNumber)
  const hasMaxAltitude = maxAltitude !== null && maxAltitude !== undefined && Number.isFinite(Number(maxAltitude))
  const hasTerrain = Boolean(terrain)
  const isHilly = hasElevationGain && (
    gainNumber >= 800 || (Number.isFinite(distanceMiles) && distanceMiles > 0 && gainNumber / distanceMiles >= 30)
  )
  const elevationSeries = intelligence?.trusted ? parseElevationSeries(race?.course_profile_json) : []

  if (!hasElevationGain && !hasMaxAltitude && !hasTerrain && !elevationSeries.length) return null

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
      {hasElevationGain && <span>↑ {gainNumber.toLocaleString()} ft gain</span>}
      {hasMaxAltitude && <span>peak {Number(maxAltitude).toLocaleString()} ft</span>}
      {hasTerrain && (
        <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
          {terrain}
        </span>
      )}
      {isHilly && (
        <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style={{ border: '1px solid var(--border-subtle)', color: 'var(--accent)' }}>
          Hilly
        </span>
      )}
      <ElevationSparkline values={elevationSeries} />
    </div>
  )
}

const COURSE_STATE_STYLES = {
  verified: { color: 'var(--accent)' },
  curated: { color: 'var(--accent)' },
  user_gpx: { color: 'var(--accent)' },
  stale: { color: 'var(--text-muted)' },
  distance_only: { color: 'var(--text-muted)' },
}

function CourseIntelligenceChip({ intelligence }) {
  if (!intelligence || !intelligence.label) return null
  const style = COURSE_STATE_STYLES[intelligence.state] || { color: 'var(--text-muted)' }
  return (
    <span
      className="mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
      style={{ border: '1px solid var(--border-subtle)', color: style.color }}
    >
      {intelligence.label}
    </span>
  )
}

function GpxUploadControl({ race, onUploaded }) {
  const [uploading, setUploading] = useState(false)
  const [note, setNote] = useState('')

  const onPick = async (event) => {
    const file = event.target.files && event.target.files[0]
    event.target.value = ''
    if (!file) return
    setUploading(true)
    setNote('')
    try {
      const data = new FormData()
      data.append('gpx', file)
      await api.post(`/races/${race.id}/course/gpx`, data)
      setNote('Course analyzed from your GPX. Coordinates are never stored.')
      if (onUploaded) await onUploaded()
    } catch (err) {
      setNote(err?.response?.data?.error || 'Could not analyze that GPX file.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="mt-2">
      <label className="inline-flex cursor-pointer rounded-lg px-3 py-1.5 text-xs font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>
        {uploading ? 'Analyzing...' : 'Upload course GPX'}
        <input type="file" accept=".gpx,application/gpx+xml,text/xml" aria-label="Upload course GPX" className="hidden" onChange={onPick} disabled={uploading} />
      </label>
      {note && <p className="mt-1 text-[11px]" role="status" aria-live="polite" style={{ color: 'var(--text-muted)' }}>{note}</p>}
    </div>
  )
}

export default function Races() {
  const navigate = useNavigate()
  const { isPro } = useProContext()
  const [races, setRaces] = useState([])
  const [form, setForm] = useState({ race_name: '', race_date: '', distance_key: '5K', distance_miles: RACE_DISTANCE_OPTIONS['5K'], location: '', goal_time_seconds: 0 })
  const [catalogForm, setCatalogForm] = useState({ q: '', distance: '', month: '', state: '' })
  const [catalogRaces, setCatalogRaces] = useState([])
  const [catalogSearched, setCatalogSearched] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [addingCatalogId, setAddingCatalogId] = useState(null)
  const [addedCatalogId, setAddedCatalogId] = useState(null)
  const [message, setMessage] = useState('')
  const [planPromptRace, setPlanPromptRace] = useState(null)
  const [generatingPlanId, setGeneratingPlanId] = useState(null)

  const load = () => api.get('/races').then((r) => setRaces(r.data.races || []))
  useEffect(() => { load() }, [])

  const upcoming = useMemo(() => races
    .filter((r) => r.status === 'upcoming' && r.race_date >= todayDateKey())
    .sort((a, b) => a.race_date.localeCompare(b.race_date)), [races])
  const past = useMemo(() => races
    .filter((r) => r.status !== 'upcoming' || r.race_date < todayDateKey())
    .sort((a, b) => b.race_date.localeCompare(a.race_date)), [races])

  const submit = async (e) => {
    e.preventDefault()
    const payload = {
      race_name: form.race_name,
      race_date: form.race_date,
      distance_miles: Number(form.distance_miles),
      location: form.location,
      goal_time_seconds: form.goal_time_seconds || null,
    }
    const res = await api.post('/races', payload)
    setMessage('Race added')
    const race = res.data.race
    setPlanPromptRace(race)
    setForm({ race_name: '', race_date: '', distance_key: '5K', distance_miles: RACE_DISTANCE_OPTIONS['5K'], location: '', goal_time_seconds: 0 })
    load()
  }

  const searchCatalog = async (e) => {
    e.preventDefault()
    setCatalogLoading(true)
    setCatalogError('')
    setCatalogSearched(true)
    setAddedCatalogId(null)
    try {
      const params = {
        q: catalogForm.q.trim() || undefined,
        distance: catalogForm.distance || undefined,
        month: catalogForm.month || undefined,
        state: catalogForm.state.trim().toUpperCase() || undefined,
      }
      const res = await api.get('/races/catalog', { params })
      setCatalogRaces(res.data.races || [])
    } catch (err) {
      setCatalogRaces([])
      setCatalogError(err?.response?.data?.error || 'Unable to search races')
    } finally {
      setCatalogLoading(false)
    }
  }

  const addCatalogRace = async (race) => {
    if (addingCatalogId) return
    setAddingCatalogId(race.id)
    setCatalogError('')
    try {
      const res = await api.post(`/races/from-catalog/${race.id}`)
      setAddedCatalogId(race.id)
      setMessage(`${race.name} added`)
      setPlanPromptRace(res.data.race || null)
      await load()
    } catch (err) {
      setCatalogError(err?.response?.data?.error || 'Unable to add race')
    } finally {
      setAddingCatalogId(null)
    }
  }

  const generateRacePlan = async (race, onSuccess) => {
    if (!isPro) {
      navigate('/upgrade')
      return
    }

    try {
      setGeneratingPlanId(race.id)
      await api.post(`/plans/generate-for-race/${race.id}`)
      onSuccess()
    } catch (err) {
      if (err?.response?.status === 402) {
        navigate('/upgrade')
        return
      }
      setMessage(err?.response?.data?.error || 'Unable to generate race plan')
    } finally {
      setGeneratingPlanId(null)
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>Races</h1>

      {planPromptRace && (
        <div className="rounded-xl p-4" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)' }}>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Build a training plan for this race?
          </p>
          <div className="flex gap-2 mt-3">
            <button
              className="rounded-lg px-3 py-1.5 text-xs font-bold"
              style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
              onClick={() => generateRacePlan(planPromptRace, () => {
                setPlanPromptRace(null)
                setMessage(`Your training plan has been updated around ${planPromptRace.race_name}`)
              })}
            >
              {generatingPlanId === planPromptRace.id ? 'Generating...' : 'Generate Race Plan'}
            </button>
            <button className="rounded-lg px-3 py-1.5 text-xs" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }} onClick={() => setPlanPromptRace(null)}>Not now</button>
          </div>
        </div>
      )}

      <section className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <div>
          <p className="text-sm font-semibold">Find a race</p>
        </div>
        <form onSubmit={searchCatalog} className="space-y-3">
          <input
            className="w-full rounded-lg px-3 py-2"
            style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
            placeholder="Race name or city"
            value={catalogForm.q}
            onChange={(e) => setCatalogForm({ ...catalogForm, q: e.target.value })}
          />
          <div className="flex flex-wrap gap-2">
            {STANDARD_RACE_DISTANCES.map(({ label, miles }) => {
              const active = String(catalogForm.distance) === String(miles)
              return (
                <button
                  key={label}
                  type="button"
                  className="rounded-full px-3 py-1.5 text-xs font-bold"
                  style={{
                    background: active ? 'var(--accent)' : 'var(--bg-input)',
                    color: active ? '#000' : 'var(--text-muted)',
                    border: '1px solid var(--border-subtle)',
                  }}
                  onClick={() => setCatalogForm({ ...catalogForm, distance: active ? '' : miles })}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select
              className="rounded-lg px-3 py-2"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
              value={catalogForm.month}
              onChange={(e) => setCatalogForm({ ...catalogForm, month: e.target.value })}
            >
              <option value="">Any month</option>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>{new Date(2024, i, 1).toLocaleString(undefined, { month: 'long' })}</option>
              ))}
            </select>
            <input
              className="rounded-lg px-3 py-2 uppercase"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
              placeholder="State"
              maxLength={2}
              value={catalogForm.state}
              onChange={(e) => setCatalogForm({ ...catalogForm, state: e.target.value.toUpperCase() })}
            />
          </div>
          <div className="flex gap-2">
            <button className="rounded-lg px-4 py-2 text-sm font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }} disabled={catalogLoading}>
              {catalogLoading ? 'Searching...' : 'Search Catalog'}
            </button>
            {(catalogForm.q || catalogForm.distance || catalogForm.month || catalogForm.state) && (
              <button
                type="button"
                className="rounded-lg px-4 py-2 text-sm"
                style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}
                onClick={() => setCatalogForm({ q: '', distance: '', month: '', state: '' })}
              >
                Clear
              </button>
            )}
          </div>
        </form>

        {catalogError && <p className="text-xs" style={{ color: 'var(--danger)' }}>{catalogError}</p>}
        {!catalogLoading && catalogSearched && !catalogError && catalogRaces.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No catalog races found.</p>
        )}
        {catalogRaces.length > 0 && (
          <div className="space-y-2">
            {catalogRaces.map((race) => (
              <div key={race.id} className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-bold" style={{ color: 'var(--text-primary)' }}>{race.name}</p>
                    <p className="text-xs" style={{ color: 'var(--accent)' }}>{formatRaceDate(race.race_date)}</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {[race.city, race.state].filter(Boolean).join(', ')} {race.distance_miles ? `· ${race.distance_miles} mi` : ''}
                    </p>
                    <CourseStats race={race} />
                  </div>
                  <span className="rounded-full px-2 py-1 text-[10px] font-bold uppercase" style={{ color: 'var(--accent)', border: '1px solid var(--border-subtle)' }}>
                    {race.scope || 'local'}
                  </span>
                </div>
                <button
                  className="mt-3 rounded-lg px-3 py-1.5 text-xs font-bold"
                  style={{ background: addedCatalogId === race.id ? 'var(--bg-card)' : 'var(--accent)', color: addedCatalogId === race.id ? 'var(--accent)' : '#0f1117', border: '1px solid var(--border-subtle)' }}
                  onClick={() => addCatalogRace(race)}
                  disabled={addingCatalogId === race.id || addedCatalogId === race.id}
                >
                  {addingCatalogId === race.id ? 'Adding...' : addedCatalogId === race.id ? 'Added' : 'Add to my races'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <form onSubmit={submit} className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-card)' }}>
        <p className="text-sm font-semibold">Add Race</p>
        <input className="w-full rounded-lg px-3 py-2" style={{ background: 'var(--bg-input)' }} placeholder="Race name" value={form.race_name} onChange={(e) => setForm({ ...form, race_name: e.target.value })} required />
        <input type="date" className="w-full rounded-lg px-3 py-2" style={{ background: 'var(--bg-input)' }} value={form.race_date} onChange={(e) => setForm({ ...form, race_date: e.target.value })} required />
        <div className="grid grid-cols-2 gap-2">
          <select className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-input)' }} value={form.distance_key} onChange={(e) => {
            const key = e.target.value
            setForm({ ...form, distance_key: key, distance_miles: RACE_DISTANCE_OPTIONS[key] ?? form.distance_miles })
          }}>
            {Object.keys(RACE_DISTANCE_OPTIONS).map((k) => <option key={k}>{k}</option>)}
          </select>
          <input type="number" min="0.1" max="100" step="0.1" className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-input)' }} placeholder="Miles" value={form.distance_miles} onChange={(e) => setForm({ ...form, distance_miles: e.target.value })} required />
        </div>
        <input className="w-full rounded-lg px-3 py-2" style={{ background: 'var(--bg-input)' }} placeholder="Location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
        <div className="space-y-1">
          <p className="text-xs font-bold" style={{ color: 'var(--text-muted)' }}>Goal time</p>
          <DurationPicker value={form.goal_time_seconds} onChange={(value) => setForm((current) => ({ ...current, goal_time_seconds: value }))} idPrefix="new-race-goal" />
        </div>
        <button className="rounded-lg px-4 py-2 font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>Save Race</button>
        {message && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{message}</p>}
      </form>

      <section className="space-y-2">
        <p className="text-sm font-semibold">Upcoming</p>
        {upcoming.map((r) => {
          const d = daysTo(r.race_date)
          return <div key={r.id} className="rounded-xl p-3" style={{ background: 'var(--bg-card)' }}>
            <p className="font-bold">{r.race_name}</p>
            <p className="text-xs" style={{ color: 'var(--accent)' }}>{d} days to go</p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{r.distance_miles} mi {r.location ? `· ${r.location}` : ''}</p>
            <CourseStats race={r} />
            {r.course_intelligence && <div><CourseIntelligenceChip intelligence={r.course_intelligence} /></div>}
            <GpxUploadControl race={r} onUploaded={load} />
            <button
              className="mt-2 rounded-lg px-3 py-1.5 text-xs font-bold"
              style={{ background: 'var(--accent)', color: '#0f1117' }}
              onClick={() => generateRacePlan(r, () => {
                setMessage(`Your training plan has been updated around ${r.race_name}`)
              })}
            >
              {generatingPlanId === r.id ? 'Generating...' : 'Generate Race Plan'}
            </button>
          </div>
        })}
      </section>

      <section className="space-y-2">
        <p className="text-sm font-semibold">Past</p>
        {past.map((r) => <div key={r.id} className="rounded-xl p-3" style={{ background: 'var(--bg-card)' }}><p className="font-semibold">{r.race_name}</p></div>)}
      </section>
    </div>
  )
}
