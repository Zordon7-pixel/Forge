import { useEffect, useMemo, useState } from 'react'
import api from '../lib/api'

const DISTANCE_OPTIONS = {
  '5K': 3.1,
  '10K': 6.2,
  Half: 13.1,
  Full: 26.2,
  Other: null,
}

function daysTo(date) {
  const ms = new Date(`${date}T12:00:00`).getTime() - Date.now()
  return Math.ceil(ms / 86400000)
}

export default function Races() {
  const [races, setRaces] = useState([])
  const [form, setForm] = useState({ race_name: '', race_date: '', distance_key: '5K', distance_miles: 3.1, location: '', goal_time: '' })
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
              onClick={async () => {
                try {
                  setGeneratingPlanId(planPromptRace.id)
                  await api.post('/plans/generate', {
                    target: {
                      raceDate: planPromptRace.race_date,
                      distanceMiles: Number(planPromptRace.distance_miles),
                      raceName: planPromptRace.race_name,
                    },
                  })
                  setPlanPromptRace(null)
                  setMessage(`Your training plan has been updated around ${planPromptRace.race_name}`)
                } finally {
                  setGeneratingPlanId(null)
                }
              }}
            >
              {generatingPlanId === planPromptRace.id ? 'Generating...' : 'Generate Race Plan'}
            </button>
            <button className="rounded-lg px-3 py-1.5 text-xs" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }} onClick={() => setPlanPromptRace(null)}>Not now</button>
          </div>
        </div>
      )}

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
              onClick={async () => {
                try {
                  setGeneratingPlanId(r.id)
                  await api.post('/plans/generate', {
                    target: {
                      raceDate: r.race_date,
                      distanceMiles: Number(r.distance_miles),
                      raceName: r.race_name,
                    },
                  })
                  setMessage(`Your training plan has been updated around ${r.race_name}`)
                } finally {
                  setGeneratingPlanId(null)
                }
              }}
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
