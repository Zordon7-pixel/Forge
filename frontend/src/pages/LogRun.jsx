import { useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api'

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function parseDurationToSeconds(mmss) {
  const [mins, secs] = mmss.split(':').map(Number)
  if (Number.isNaN(mins) || Number.isNaN(secs)) return null
  return mins * 60 + secs
}

export default function LogRun() {
  const [date, setDate] = useState(todayISO())
  const [distance, setDistance] = useState('')
  const [duration, setDuration] = useState('30:00')
  const [notes, setNotes] = useState('')
  const [effort, setEffort] = useState(5)
  const [loading, setLoading] = useState(false)
  const [polling, setPolling] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')

  const onSubmit = async e => {
    e.preventDefault()
    setError('')
    setFeedback('')

    const seconds = parseDurationToSeconds(duration)
    if (!seconds) {
      setError('Duration must be in MM:SS format.')
      return
    }

    try {
      setLoading(true)
      const runRes = await api.post('/runs', {
        date,
        distance: Number(distance),
        duration_seconds: seconds,
        notes,
        effort: Number(effort)
      })

      const runId = runRes.data?.id || runRes.data?.run?.id
      if (!runId) {
        setFeedback('Feedback coming soon...')
        return
      }

      setPolling(true)
      let attempts = 0
      let aiFeedback = ''

      while (attempts < 5 && !aiFeedback) {
        attempts += 1
        await new Promise(resolve => setTimeout(resolve, 2000))
        const feedbackRes = await api.get(`/api/coach/feedback/${runId}`)
        aiFeedback = feedbackRes.data?.ai_feedback || ''
      }

      setFeedback(aiFeedback || 'Feedback coming soon...')
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not log run.')
    } finally {
      setLoading(false)
      setPolling(false)
    }
  }

  return (
    <div className="rounded-2xl bg-[#111318] p-4">
      <h2 className="mb-4 text-xl font-bold">Log Run</h2>

      <form onSubmit={onSubmit} className="space-y-4">
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3"
        />
        <input
          type="number"
          step="0.01"
          min="0"
          required
          placeholder="Distance (miles)"
          value={distance}
          onChange={e => setDistance(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3"
        />
        <input
          type="text"
          required
          placeholder="Duration (MM:SS)"
          value={duration}
          onChange={e => setDuration(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3"
        />
        <textarea
          rows={4}
          placeholder="Route / notes"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3"
        />

        <div>
          <label className="mb-2 block text-sm text-gray-300">Effort: {effort}/10</label>
          <input
            type="range"
            min="1"
            max="10"
            value={effort}
            onChange={e => setEffort(e.target.value)}
            className="w-full accent-orange-500"
          />
        </div>

        <button
          type="submit"
          disabled={loading || polling}
          className="w-full rounded-xl bg-orange-500 py-3 font-semibold text-white disabled:opacity-70"
        >
          {loading ? 'Logging run...' : 'Save Run'}
        </button>
      </form>

      {(loading || polling) && (
        <div className="mt-4 flex items-center gap-2 text-sm text-gray-300">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
          Getting AI feedback...
        </div>
      )}

      {feedback && <div className="mt-4 rounded-xl bg-orange-500/15 p-3 text-orange-300">{feedback}</div>}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

      <Link to="/" className="mt-5 inline-block text-sm text-gray-300 hover:text-white">
        ← Back
      </Link>
    </div>
  )
}
