import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProContext } from '../context/ProContext'
import api from '../lib/api'

const DISTANCE_OPTIONS = {
  '5K': 3.1,
  '10K': 6.2,
  Half: 13.1,
  Full: 26.2,
  Other: null,
}

const CATALOG_DISTANCE_OPTIONS = [
  ['5K', 3.1],
  ['10K', 6.2],
  ['Half', 13.1],
  ['Marathon', 26.2],
]

function daysTo(date) {
  const ms = new Date(`${date}T12:00:00`).getTime() - Date.now()
  return Math.ceil(ms / 86400000)
}

function formatRaceDate(date) {
  if (!date) return ''
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function Races() {
  const navigate = useNavigate()
  const { isPro } = useProContext()
  const [races, setRaces] = useState([])
  const [form, setForm] = useState({ race_name: '', race_date: '', distance_key: '5K', distance_miles: 3.1, location: '', goal_time: '' })
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

  const upcoming = useMemo(() => races.filter((r) => r.status === 'upcoming').sort((a, b) => a.race_date.localeCompare(b.race_date)), [races])
  const past = useMemo(() => races.filter((r) => r.status !== 'upcoming').sort((a, b) => b.race_date.localeCompare(a.race_date)), [races])

  const submit = async (e) => {
    e.preventDefault()
    const goal_time_seconds = form.goal_time ? form.goal_time.split(':').reduce((acc, v) => acc * 60 + Number(v), 0) : null
    const payload = {
      race_name: form.race_name,
      race_date: form.race_date,
      distance_miles: Number(form.distance_miles),
      location: form.location,
      goal_time_seconds,
    }
    const res = await api.post('/races', payload)
    setMessage('Race added')
    const race = res.data.race
    setPlanPromptRace(race)
    setForm({ race_name: '', race_date: '', distance_key: '5K', distance_miles: 3.1, location: '', goal_time: '' })
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
      await api.post('/plans/generate', {
        target: {
          raceDate: race.race_date,
          distanceMiles: Number(race.distance_miles),
          raceName: race.race_name,
        },
      })
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
        <div className="rounded-xl p-4" style={{ background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.3)' }}>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Build a training plan for this race?
          </p>
          <div className="flex gap-2 mt-3">
            <button
              className="rounded-lg px-3 py-1.5 text-xs font-bold"
              style={{ background: 'var(--accent)', color: '#000' }}
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
            {CATALOG_DISTANCE_OPTIONS.map(([label, miles]) => {
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
            <button className="rounded-lg px-4 py-2 text-sm font-bold" style={{ background: 'var(--accent)', color: '#000' }} disabled={catalogLoading}>
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

        {catalogError && <p className="text-xs" style={{ color: '#fca5a5' }}>{catalogError}</p>}
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
                  </div>
                  <span className="rounded-full px-2 py-1 text-[10px] font-bold uppercase" style={{ color: 'var(--accent)', border: '1px solid rgba(234,179,8,0.35)' }}>
                    {race.scope || 'local'}
                  </span>
                </div>
                <button
                  className="mt-3 rounded-lg px-3 py-1.5 text-xs font-bold"
                  style={{ background: addedCatalogId === race.id ? 'var(--bg-card)' : '#EAB308', color: addedCatalogId === race.id ? 'var(--accent)' : '#0f1117', border: '1px solid var(--border-subtle)' }}
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
            setForm({ ...form, distance_key: key, distance_miles: DISTANCE_OPTIONS[key] ?? form.distance_miles })
          }}>
            {Object.keys(DISTANCE_OPTIONS).map((k) => <option key={k}>{k}</option>)}
          </select>
          <input type="number" step="0.1" className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-input)' }} placeholder="Miles" value={form.distance_miles} onChange={(e) => setForm({ ...form, distance_miles: e.target.value })} required />
        </div>
        <input className="w-full rounded-lg px-3 py-2" style={{ background: 'var(--bg-input)' }} placeholder="Location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
        <input className="w-full rounded-lg px-3 py-2" style={{ background: 'var(--bg-input)' }} placeholder="Goal time (hh:mm:ss)" value={form.goal_time} onChange={(e) => setForm({ ...form, goal_time: e.target.value })} />
        <button className="rounded-lg px-4 py-2 font-bold" style={{ background: 'var(--accent)', color: '#000' }}>Save Race</button>
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
            <button
              className="mt-2 rounded-lg px-3 py-1.5 text-xs font-bold"
              style={{ background: '#EAB308', color: '#0f1117' }}
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
