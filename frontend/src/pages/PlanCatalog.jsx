import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { CalendarDays, ChevronRight, MapPin, Search, X } from 'lucide-react'
import api from '../lib/api'
import { previewAndApplyPlan } from '../lib/planCandidates'
import { isPlanCandidateReviewCancelled } from '../lib/planCandidateReview'
import { activateModalDialog } from '../lib/modalDialog'
import { useProContext } from '../context/ProContext'
import DurationPicker from '../components/DurationPicker'
import { formatDuration, normalizeDurationSeconds } from '../lib/duration'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const PLAN_GENERATION_TIMEOUT_MS = 90000

function localTodayISO() {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

const PLAN_GOALS = [
  { key: '5k', kind: 'block', name: '5K', distanceMiles: 3.1, duration: '6-8 weeks', feel: 'Fast, sharp, repeatable' },
  { key: '10k', kind: 'block', name: '10K', distanceMiles: 6.2, duration: '8-10 weeks', feel: 'Speed with stamina' },
  { key: 'half', kind: 'block', name: 'Half Marathon', distanceMiles: 13.1, duration: '10-14 weeks', feel: 'Durable aerobic build' },
  { key: 'marathon', kind: 'block', name: 'Marathon', distanceMiles: 26.2, duration: '14-18 weeks', feel: 'Long-range endurance' },
  { key: 'custom', kind: 'block', name: 'Custom Distance', distanceMiles: null, duration: 'Flexible', feel: 'Build without a race date' },
]

const EQUIPMENT_PRESETS = {
  full_gym: ['barbell', 'dumbbell', 'rack', 'bench', 'cable', 'machines'],
  home_gym: ['barbell', 'dumbbell', 'rack', 'bench'],
  dumbbells: ['dumbbell', 'bench'],
  minimal: ['bodyweight', 'resistance_bands'],
}

function plausibleGoalTime(seconds, distanceMiles) {
  const distance = Number(distanceMiles)
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(distance) || distance <= 0) return false
  const pace = seconds / distance
  return pace >= 180 && pace <= 1800
}

function formatGoalPace(seconds, distanceMiles) {
  const pace = Number(seconds) / Number(distanceMiles)
  if (!Number.isFinite(pace) || pace <= 0) return ''
  const rounded = Math.round(pace)
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}/mi`
}

function sortDays(days) {
  return [...new Set(days)].filter((day) => DAYS.includes(day)).sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b))
}

function isValidISODate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false
  const parsed = new Date(`${value}T12:00:00`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function formatRaceDate(value) {
  if (!isValidISODate(value)) return 'Date not set'
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function raceLocation(race = {}) {
  return [race.city, race.state].filter(Boolean).join(', ') || race.location || race.country || ''
}

function raceName(race = {}) {
  return race.name || race.race_name || 'Race'
}

function raceDistance(race = {}) {
  return Number(race.distance_miles || 0)
}

function weeksToRace(value) {
  if (!isValidISODate(value)) return null
  const race = new Date(`${value}T12:00:00`)
  const today = new Date(`${localTodayISO()}T12:00:00`)
  const days = Math.ceil((race.getTime() - today.getTime()) / 86400000)
  return days >= 0 ? Math.max(1, Math.ceil(days / 7)) : null
}

export default function PlanCatalog() {
  const navigate = useNavigate()
  const location = useLocation()
  const requestedRaceHandledRef = useRef(false)
  const planDialogRef = useRef(null)
  const { isPro, loading: proLoading } = useProContext()
  const todayISO = localTodayISO()
  const [selectedGoal, setSelectedGoal] = useState(null)
  const [prefillLoading, setPrefillLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generationStep, setGenerationStep] = useState('')
  const [error, setError] = useState('')
  const [trainingDays, setTrainingDays] = useState(['Tue', 'Thu', 'Sat'])
  const [runDaysPerWeek, setRunDaysPerWeek] = useState(3)
  const [liftingEnabled, setLiftingEnabled] = useState(false)
  const [strengthMode, setStrengthMode] = useState('hybrid_maintain')
  const [liftDaysPerWeek, setLiftDaysPerWeek] = useState(0)
  const [equipmentPreset, setEquipmentPreset] = useState('full_gym')
  const [weeks, setWeeks] = useState('')
  const [goalTime, setGoalTime] = useState(0)
  const [customDistance, setCustomDistance] = useState('')
  const [raceQuery, setRaceQuery] = useState('')
  const [raceResults, setRaceResults] = useState([])
  const [raceSearchLoading, setRaceSearchLoading] = useState(false)
  const [raceSearchError, setRaceSearchError] = useState('')
  const [raceSearched, setRaceSearched] = useState(false)
  const [savedRaces, setSavedRaces] = useState([])
  const [raceSelection, setRaceSelection] = useState(null)
  const [raceDraft, setRaceDraft] = useState({ name: '', date: '', location: '' })

  const isRacePlan = selectedGoal?.kind === 'race'
  const selectedDistance = useMemo(() => {
    if (!selectedGoal) return ''
    return selectedGoal.key === 'custom' || selectedGoal.kind === 'race'
      ? Number(customDistance || 0)
      : selectedGoal.distanceMiles
  }, [customDistance, selectedGoal])
  const parsedGoalTime = goalTime > 0
    ? (plausibleGoalTime(goalTime, selectedDistance) ? goalTime : null)
    : undefined
  const raceWeeks = useMemo(() => weeksToRace(raceDraft.date), [raceDraft.date])
  const selectedCourse = raceSelection?.race?.course_intelligence || null

  useEffect(() => {
    if (!selectedGoal) return undefined
    return activateModalDialog({
      dialog: planDialogRef.current,
      onClose: () => setSelectedGoal(null),
    })
  }, [selectedGoal])

  useEffect(() => {
    let active = true
    api.get('/races')
      .then(({ data }) => {
        if (!active) return
        const upcoming = (Array.isArray(data?.races) ? data.races : [])
          .filter((race) => race.status === 'upcoming' && race.race_date >= todayISO)
          .sort((a, b) => String(a.race_date).localeCompare(String(b.race_date)))
        setSavedRaces(upcoming)
      })
      .catch((err) => console.error('[PlanCatalog] saved race load failed:', err.message))
    return () => { active = false }
  }, [todayISO])

  const ensurePro = () => {
    if (proLoading) return false
    if (isPro !== true) {
      navigate('/upgrade')
      return false
    }
    return true
  }

  const loadPrefill = async () => {
    setPrefillLoading(true)
    try {
      const { data } = await api.get('/plans/prefill')
      const inferred = Array.isArray(data?.inferredTrainingDays) && data.inferredTrainingDays.length
        ? data.inferredTrainingDays
        : ['Tue', 'Thu', 'Sat']
      const available = sortDays(inferred)
      const runCount = Math.max(1, Math.min(6, available.length, Number(data?.runDaysPerWeek || 3)))
      const liftCount = Math.max(0, Math.min(available.length, Number(data?.liftDaysPerWeek || 0)))
      setTrainingDays(available)
      setRunDaysPerWeek(runCount)
      setLiftingEnabled(Boolean(data?.liftingEnabled))
      setLiftDaysPerWeek(liftCount)
      setStrengthMode('hybrid_maintain')
    } catch (err) {
      if (err?.response?.status === 402) {
        navigate('/upgrade')
        return
      }
      console.error('[PlanCatalog] prefill failed:', err.message)
      setError(err?.response?.data?.error || 'Could not load your usual training rhythm. You can still edit the plan.')
    } finally {
      setPrefillLoading(false)
    }
  }

  const openGoal = async (goal) => {
    if (!ensurePro()) return
    setSelectedGoal(goal)
    setError('')
    setGoalTime(0)
    setWeeks('')
    setCustomDistance(goal.key === 'custom' ? '' : String(goal.distanceMiles))
    setRaceSelection(null)
    setRaceDraft({ name: '', date: '', location: '' })
    await loadPrefill()
  }

  const openRace = async (race = null, selectionType = 'catalog') => {
    if (!ensurePro()) return
    const name = race ? raceName(race) : ''
    setSelectedGoal({
      key: 'race',
      kind: 'race',
      name: name || 'Custom race',
      distanceMiles: race ? raceDistance(race) : null,
      duration: 'Through race day',
      feel: race ? 'Course-aware race build' : 'Enter the event details',
    })
    setError('')
    setGoalTime(normalizeDurationSeconds(race?.goal_time_seconds))
    setWeeks('')
    setCustomDistance(race ? String(raceDistance(race)) : '')
    setRaceSelection(race ? { type: selectionType, race } : null)
    setRaceDraft({
      name,
      date: race?.race_date || '',
      location: race ? raceLocation(race) : '',
    })
    await loadPrefill()
  }

  useEffect(() => {
    const requestedRaceId = location.state?.raceId
    if (!requestedRaceId || requestedRaceHandledRef.current || !savedRaces.length) return
    const race = savedRaces.find((item) => String(item.id) === String(requestedRaceId))
    requestedRaceHandledRef.current = true
    navigate(location.pathname, { replace: true, state: null })
    if (race) void openRace(race, 'owned')
    // openRace intentionally runs once for the navigation state handoff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.state?.raceId, navigate, savedRaces])

  const searchRaces = async (event) => {
    event.preventDefault()
    const query = raceQuery.trim()
    if (query.length < 2) {
      setRaceSearchError('Enter at least two letters from the race name or location.')
      return
    }
    setRaceSearchLoading(true)
    setRaceSearchError('')
    setRaceSearched(true)
    try {
      const { data } = await api.get('/races/catalog', { params: { q: query } })
      setRaceResults(Array.isArray(data?.races) ? data.races.slice(0, 8) : [])
    } catch (err) {
      console.error('[PlanCatalog] race search failed:', err.message)
      setRaceResults([])
      setRaceSearchError(err?.response?.data?.error || 'Race search is unavailable right now.')
    } finally {
      setRaceSearchLoading(false)
    }
  }

  const updateRaceDraft = (field, value) => {
    setRaceSelection(null)
    setRaceDraft((current) => ({ ...current, [field]: value }))
  }

  const toggleDay = (day) => {
    setTrainingDays((prev) => {
      const next = sortDays(prev.includes(day) ? prev.filter((item) => item !== day) : [...prev, day])
      setRunDaysPerWeek((current) => Math.max(1, Math.min(6, current, Math.max(1, next.length))))
      setLiftDaysPerWeek((current) => Math.min(current, next.length))
      return next
    })
  }

  const generatePlan = async () => {
    const goalTimeSeconds = parsedGoalTime
    const parsedWeeks = Number(weeks)
    const distanceMiles = Number(selectedDistance)
    const runCount = Number(runDaysPerWeek)
    const liftCount = liftingEnabled ? Number(liftDaysPerWeek) : 0

    if (!distanceMiles || distanceMiles <= 0 || distanceMiles > 100) {
      setError('Enter a target distance between 0.1 and 100 miles.')
      return
    }
    if (isRacePlan && !raceDraft.name.trim()) {
      setError('Enter or select the race name.')
      return
    }
    if (isRacePlan && (!isValidISODate(raceDraft.date) || raceDraft.date < localTodayISO())) {
      setError('Choose the race date from the calendar. It must be today or later.')
      return
    }
    if (goalTimeSeconds === null) {
      setError('Choose a goal pace between 3:00 and 30:00 per mile.')
      return
    }
    if (!isRacePlan && weeks && (!Number.isInteger(parsedWeeks) || parsedWeeks < 4 || parsedWeeks > 20)) {
      setError('Weeks must be a whole number from 4 to 20.')
      return
    }
    if (!trainingDays.length) {
      setError('Choose at least one available training day.')
      return
    }
    if (!Number.isInteger(runCount) || runCount < 1 || runCount > 6 || runCount > trainingDays.length) {
      setError('Run days must be a whole number from 1 to 6 and fit inside your eligible weekdays.')
      return
    }
    if (liftingEnabled && (!Number.isInteger(liftCount) || liftCount < 1 || liftCount > trainingDays.length)) {
      setError('Lift days must fit inside your available training days.')
      return
    }

    setGenerating(true)
    setGenerationStep(isRacePlan ? 'Saving race...' : 'Building your calendar...')
    setError('')
    try {
      const target = {
        distanceMiles,
        trainingDays,
        runDaysPerWeek: runCount,
        liftingEnabled,
        liftDaysPerWeek: liftCount,
        planMode: liftingEnabled ? strengthMode : 'run_only',
        strengthGoal: strengthMode === 'hybrid_build' ? 'build' : 'maintain',
        equipment: liftingEnabled ? EQUIPMENT_PRESETS[equipmentPreset] : [],
      }
      if (goalTimeSeconds) target.goalTimeSeconds = goalTimeSeconds

      if (isRacePlan) {
        let ownedRace = raceSelection?.type === 'owned' ? raceSelection.race : null
        if (!ownedRace && raceSelection?.type === 'catalog') {
          const catalogRaceOptions = goalTimeSeconds ? { goal_time_seconds: goalTimeSeconds } : {}
          const { data } = await api.post(
            `/races/from-catalog/${encodeURIComponent(raceSelection.race.id)}`,
            catalogRaceOptions,
          )
          ownedRace = data?.race
        }
        if (!ownedRace) {
          const { data } = await api.post('/races', {
            race_name: raceDraft.name.trim(),
            race_date: raceDraft.date,
            distance_miles: distanceMiles,
            location: raceDraft.location.trim() || null,
            goal_time_seconds: goalTimeSeconds || null,
            status: 'upcoming',
          })
          ownedRace = data?.race
        }
        const requestedGoalTime = goalTimeSeconds || null
        if (ownedRace && raceSelection?.type === 'owned' && Number(ownedRace.goal_time_seconds || 0) !== Number(requestedGoalTime || 0)) {
          const { data } = await api.patch(`/races/${encodeURIComponent(ownedRace.id)}`, { goal_time_seconds: requestedGoalTime })
          ownedRace = data?.race || ownedRace
        }
        if (!ownedRace?.id) throw new Error('Race could not be saved before plan generation.')
        setRaceSelection({ type: 'owned', race: ownedRace })
        setGenerationStep('Building your race calendar...')
        await previewAndApplyPlan(
          `/plans/generate-for-race/${encodeURIComponent(ownedRace.id)}`,
          { target },
          { timeout: PLAN_GENERATION_TIMEOUT_MS },
        )
      } else {
        if (weeks) target.weeks = parsedWeeks
        setGenerationStep('Building your calendar...')
        await previewAndApplyPlan('/plans/generate', { target }, { timeout: PLAN_GENERATION_TIMEOUT_MS })
      }
      navigate('/plan')
    } catch (err) {
      if (isPlanCandidateReviewCancelled(err)) return
      if (err?.response?.status === 402) {
        navigate('/upgrade')
        return
      }
      console.error('[PlanCatalog] plan generation failed:', err.message)
      if (err?.code === 'ECONNABORTED') {
        setError('The plan is taking longer than expected. Open Training Plan in a moment before trying again; Forged Hybrid may still be finishing it.')
      } else {
        setError(err?.response?.data?.error || err?.message || 'Unable to generate this plan right now.')
      }
    } finally {
      setGenerating(false)
      setGenerationStep('')
    }
  }

  return (
    <div style={{ paddingBottom: 112 }}>
      <header style={{ marginBottom: 20 }}>
        <p style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 900, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>Create / Manage Plan</p>
        <h1 style={{ color: 'var(--text-primary)', fontSize: 30, fontWeight: 950, margin: 0 }}>Build around your race.</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 8, maxWidth: 560 }}>
          Find the event, confirm its date, then choose the days you can train. Forged Hybrid builds the run and optional lift calendar through race day.
        </p>
      </header>

      <section style={{ padding: '4px 0 22px', borderBottom: '1px solid var(--border-subtle)', marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <Search size={18} color="var(--accent)" />
          <h2 style={{ color: 'var(--text-primary)', fontSize: 18, fontWeight: 950, margin: 0 }}>Find your race</h2>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 12px' }}>
          Search by race name or location. Known dates, distance, and trusted course details fill automatically.
        </p>
        {savedRaces.length > 0 && (
          <label style={{ display: 'grid', gap: 6, marginBottom: 10, maxWidth: 420 }}>
            <span style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 850 }}>Use one of your saved races</span>
            <select
              value=""
              onChange={(event) => {
                const race = savedRaces.find((item) => item.id === event.target.value)
                if (race) openRace(race, 'owned')
              }}
              aria-label="Use a saved race"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '11px 12px', fontSize: 14 }}
            >
              <option value="">Select a saved race</option>
              {savedRaces.map((race) => <option key={race.id} value={race.id}>{raceName(race)} - {formatRaceDate(race.race_date)}</option>)}
            </select>
          </label>
        )}
        <form onSubmit={searchRaces} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <input
            type="search"
            value={raceQuery}
            onChange={(event) => setRaceQuery(event.target.value)}
            placeholder="Army Ten-Miler or Washington, DC"
            aria-label="Search race catalog"
            style={{ flex: '1 1 230px', minWidth: 0, background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', fontSize: 16 }}
          />
          <button type="submit" disabled={raceSearchLoading} className="rounded-lg px-4 py-3 font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', opacity: raceSearchLoading ? 0.65 : 1 }}>
            {raceSearchLoading ? 'Searching...' : 'Search'}
          </button>
          <button type="button" onClick={() => openRace()} className="rounded-lg px-4 py-3 font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
            Enter manually
          </button>
        </form>

        {raceSearchError && <p role="alert" style={{ color: 'var(--danger)', fontSize: 13, marginTop: 10 }}>{raceSearchError}</p>}
        {raceSearched && !raceSearchLoading && !raceSearchError && raceResults.length === 0 && (
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 12 }}>No matching race yet. Enter it manually and the plan will use distance-only course logic.</p>
        )}
        {raceResults.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10, marginTop: 14 }}>
            {raceResults.map((race) => {
              const course = race.course_intelligence
              return (
                <article key={race.id} className="rounded-lg p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', minWidth: 0 }}>
                  <p style={{ color: 'var(--text-primary)', fontSize: 15, fontWeight: 950, margin: 0, overflowWrap: 'anywhere' }}>{raceName(race)}</p>
                  <p style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 850, margin: '5px 0 0' }}>{formatRaceDate(race.race_date)} · {raceDistance(race)} mi</p>
                  <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 5 }}><MapPin size={12} /> {raceLocation(race) || 'Location not listed'}</p>
                  {course && <p style={{ color: course.trusted ? 'var(--success)' : 'var(--text-muted)', fontSize: 11, fontWeight: 850, margin: '7px 0 0' }}>{course.label}</p>}
                  <button type="button" onClick={() => openRace(race)} className="rounded-lg px-3 py-2" style={{ marginTop: 10, width: '100%', background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', fontSize: 13, fontWeight: 950 }}>
                    Use this race
                  </button>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section>
        <h2 style={{ color: 'var(--text-primary)', fontSize: 18, fontWeight: 950, margin: '0 0 4px' }}>No race selected?</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 12px' }}>Build a distance-focused training block without a race date.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          {PLAN_GOALS.map((goal) => (
            <button
              key={goal.key}
              type="button"
              onClick={() => openGoal(goal)}
              className="rounded-lg p-4"
              style={{
                minHeight: 142,
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-primary)',
                textAlign: 'left',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                cursor: 'pointer',
              }}
            >
              <span>
                <span style={{ display: 'block', fontSize: 22, fontWeight: 950, letterSpacing: 0 }}>{goal.name}</span>
                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 13, fontWeight: 800, marginTop: 6 }}>{goal.duration}</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: 'var(--accent)', fontSize: 13, fontWeight: 900 }}>{goal.feel}</span>
                <ChevronRight size={20} color="var(--accent)" />
              </span>
            </button>
          ))}
        </div>
      </section>

      {selectedGoal && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.68)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 10 }}
        >
          <div
            ref={planDialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="plan-options-title"
            className="rounded-lg p-4"
            style={{ width: 'min(660px, 100%)', maxHeight: '92vh', overflowY: 'auto', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', boxShadow: '0 24px 80px rgba(0,0,0,0.45)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 900, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>{isRacePlan ? 'Race Target' : 'Training Block'}</p>
                <h2 id="plan-options-title" style={{ color: 'var(--text-primary)', fontSize: 23, fontWeight: 950, margin: 0, overflowWrap: 'anywhere' }}>{isRacePlan ? raceDraft.name || 'Custom race' : selectedGoal.name}</h2>
                <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>{selectedGoal.duration} / {selectedGoal.feel}</p>
              </div>
              <button type="button" onClick={() => setSelectedGoal(null)} aria-label="Close plan options" style={{ flex: '0 0 auto', width: 38, height: 38, display: 'grid', placeItems: 'center', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 8, color: 'var(--text-primary)' }}>
                <X size={18} />
              </button>
            </div>

            {prefillLoading && <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>Loading your usual training rhythm...</p>}
            {error && <div role="alert" className="rounded-lg p-3" style={{ background: 'var(--danger-dim)', border: '1px solid var(--danger-dim)', color: 'var(--danger)', fontSize: 13, fontWeight: 700, marginBottom: 12 }}>{error}</div>}

            <div style={{ display: 'grid', gap: 16 }}>
              {isRacePlan && (
                <section aria-label="Race details" style={{ display: 'grid', gap: 12 }}>
                  <label style={{ display: 'grid', gap: 7 }}>
                    <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Race name</span>
                    <input value={raceDraft.name} onChange={(event) => updateRaceDraft('name', event.target.value)} placeholder="Race or event name" maxLength={200} style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', fontSize: 16 }} />
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                    <label style={{ display: 'grid', gap: 7 }}>
                      <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850, display: 'flex', alignItems: 'center', gap: 6 }}><CalendarDays size={15} color="var(--accent)" /> Race date</span>
                      <input type="date" min={todayISO} value={raceDraft.date} onChange={(event) => updateRaceDraft('date', event.target.value)} style={{ minWidth: 0, background: 'var(--bg-input)', color: 'var(--text-primary)', colorScheme: 'dark', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '11px 12px', fontSize: 16 }} />
                    </label>
                    <label style={{ display: 'grid', gap: 7 }}>
                      <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Distance miles</span>
                      <input type="number" min="0.1" max="100" step="0.1" value={customDistance} onChange={(event) => { setRaceSelection(null); setCustomDistance(event.target.value) }} inputMode="decimal" placeholder="10.0" style={{ minWidth: 0, background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', fontSize: 16 }} />
                    </label>
                  </div>
                  <label style={{ display: 'grid', gap: 7 }}>
                    <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Location</span>
                    <input value={raceDraft.location} onChange={(event) => updateRaceDraft('location', event.target.value)} placeholder="City, state or country" maxLength={200} style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', fontSize: 16 }} />
                  </label>
                  {raceDraft.date && (
                    <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}>
                      {raceWeeks ? `${raceWeeks} week${raceWeeks === 1 ? '' : 's'} available. ` : ''}Forged Hybrid calculates the exact calendar through race day.
                    </p>
                  )}
                  {selectedCourse && (
                    <div className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                      <p style={{ color: selectedCourse.trusted ? 'var(--success)' : 'var(--text-muted)', fontSize: 12, fontWeight: 900, margin: 0 }}>{selectedCourse.label}</p>
                      {selectedCourse.trusted && (
                        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '5px 0 0' }}>
                          {[selectedCourse.facts?.elevationGainFt != null ? `${selectedCourse.facts.elevationGainFt} ft gain` : null, selectedCourse.facts?.terrain].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </div>
                  )}
                </section>
              )}

              {!isRacePlan && selectedGoal.key === 'custom' && (
                <label style={{ display: 'grid', gap: 8 }}>
                  <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Distance miles</span>
                  <input type="number" min="0.1" max="100" step="0.1" value={customDistance} onChange={(event) => setCustomDistance(event.target.value)} inputMode="decimal" placeholder="8.0" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', fontSize: 16 }} />
                </label>
              )}

              <section>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
                  <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Eligible workout weekdays</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 800 }}>{trainingDays.length} days/week</span>
                </div>
                <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '0 0 10px' }}>Runs are scheduled only on these weekdays. Choose the exact number of weekly runs below.</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6 }}>
                  {DAYS.map((day) => {
                    const active = trainingDays.includes(day)
                    return (
                      <button key={day} type="button" aria-pressed={active} onClick={() => toggleDay(day)} style={{ minHeight: 44, minWidth: 0, borderRadius: 8, border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`, background: active ? 'var(--accent-dim)' : 'var(--bg-input)', color: active ? 'var(--accent)' : 'var(--text-muted)', fontSize: 11, fontWeight: 950 }}>
                        {day}
                      </button>
                    )
                  })}
                </div>
              </section>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
                <label style={{ display: 'grid', gap: 7 }}>
                  <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>How many days do you want to run?</span>
                  <select value={runDaysPerWeek} onChange={(event) => setRunDaysPerWeek(Number(event.target.value))} style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', fontSize: 15 }}>
                    {Array.from({ length: Math.max(1, Math.min(6, trainingDays.length)) }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count} run day{count === 1 ? '' : 's'}</option>)}
                  </select>
                </label>
                {liftingEnabled && (
                  <label style={{ display: 'grid', gap: 7 }}>
                    <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Lift days each week</span>
                    <select value={Math.max(1, liftDaysPerWeek)} onChange={(event) => setLiftDaysPerWeek(Number(event.target.value))} style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', fontSize: 15 }}>
                      {Array.from({ length: Math.max(1, Math.min(4, trainingDays.length)) }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count} lift day{count === 1 ? '' : 's'}</option>)}
                    </select>
                  </label>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                <label style={{ display: 'grid', gap: 8 }}>
                  <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Goal time</span>
                  <DurationPicker value={goalTime} onChange={setGoalTime} idPrefix="plan-goal" />
                  {goalTime > 0 && parsedGoalTime && (
                    <span style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 850 }}>
                      Target: {formatDuration(parsedGoalTime, { padHours: true })} · {formatGoalPace(parsedGoalTime, selectedDistance)}
                    </span>
                  )}
                  {goalTime > 0 && parsedGoalTime === null && (
                    <span style={{ color: 'var(--danger)', fontSize: 12 }}>Choose a goal pace between 3:00 and 30:00 per mile.</span>
                  )}
                  {!goalTime && (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Optional. Leave blank for a conservative faster target based on recent synced best efforts.</span>
                  )}
                </label>
                {!isRacePlan && (
                  <label style={{ display: 'grid', gap: 8 }}>
                    <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Weeks</span>
                    <input type="number" min="4" max="20" value={weeks} onChange={(event) => setWeeks(event.target.value)} placeholder="optional" inputMode="numeric" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', fontSize: 16 }} />
                  </label>
                )}
              </div>

              <section>
                <span style={{ display: 'block', color: 'var(--text-primary)', fontSize: 13, fontWeight: 850, marginBottom: 8 }}>Training mode</span>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 8 }}>
                  {[
                    { mode: 'run_only', label: 'Run only', detail: 'No lifting sessions' },
                    { mode: 'hybrid_maintain', label: 'Maintain strength', detail: 'Protect size and strength' },
                    { mode: 'hybrid_build', label: 'Build strength', detail: 'Progress lifting volume' },
                  ].map((option) => {
                    const active = option.mode === 'run_only' ? !liftingEnabled : liftingEnabled && strengthMode === option.mode
                    return (
                      <button key={option.mode} type="button" aria-pressed={active}
                        onClick={() => {
                          const enabled = option.mode !== 'run_only'
                          setLiftingEnabled(enabled)
                          if (enabled) {
                            setStrengthMode(option.mode)
                            const preferred = option.mode === 'hybrid_build' ? 3 : 2
                            setLiftDaysPerWeek((current) => Math.max(1, Math.min(trainingDays.length, Math.max(Number(current || 0), preferred))))
                          } else {
                            setLiftDaysPerWeek(0)
                          }
                        }}
                        style={{ minHeight: 68, padding: '10px 12px', borderRadius: 8, textAlign: 'left', border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`, background: active ? 'var(--accent-dim)' : 'var(--bg-input)', color: 'var(--text-primary)' }}>
                        <span style={{ display: 'block', fontSize: 13, fontWeight: 900 }}>{option.label}</span>
                        <span style={{ display: 'block', marginTop: 3, color: active ? 'var(--accent)' : 'var(--text-muted)', fontSize: 11 }}>{option.detail}</span>
                      </button>
                    )
                  })}
                </div>
              </section>

              {liftingEnabled && (
                <label style={{ display: 'grid', gap: 8 }}>
                  <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Equipment available</span>
                  <select value={equipmentPreset} onChange={(event) => setEquipmentPreset(event.target.value)} style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', fontSize: 15 }}>
                    <option value="full_gym">Full gym</option>
                    <option value="home_gym">Barbell, rack and dumbbells</option>
                    <option value="dumbbells">Dumbbells and bench</option>
                    <option value="minimal">Bodyweight and resistance bands</option>
                  </select>
                </label>
              )}

              <button type="button" onClick={generatePlan} disabled={generating || prefillLoading} className="rounded-lg p-4" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', fontSize: 15, fontWeight: 950, opacity: generating || prefillLoading ? 0.65 : 1 }}>
                {generating ? generationStep || 'Generating...' : isRacePlan ? 'Build Race Calendar' : 'Generate Training Block'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
