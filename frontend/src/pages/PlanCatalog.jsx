import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { CalendarDays, ChevronRight, MapPin, Search, X } from 'lucide-react'
import api from '../lib/api'
import { getAuthSession, isAuthSessionCurrent, subscribeAuthSession } from '../lib/tokenStore'
import { previewAndApplyPlan } from '../lib/planCandidates'
import { isPlanCandidateReviewCancelled } from '../lib/planCandidateReview'
import { activateModalDialog } from '../lib/modalDialog'
import { useProContext } from '../context/ProContext'
import DurationPicker from '../components/DurationPicker'
import HyroxPlanSetup from '../components/hyrox/HyroxPlanSetup'
import { formatDuration, normalizeDurationSeconds } from '../lib/duration'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const PLAN_GENERATION_TIMEOUT_MS = 90000
// Memory-only, session-bound return from the existing upgrade screen. No race
// or account data is written to browser storage. A full reload loses this draft.
let upgradeDraft = null
subscribeAuthSession(() => { upgradeDraft = null })

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
  return !Number.isNaN(parsed.getTime()) && parsed.getFullYear() === Number(value.slice(0, 4))
    && parsed.getMonth() + 1 === Number(value.slice(5, 7)) && parsed.getDate() === Number(value.slice(8, 10))
}

// No-owned-race targets start at planningDateLocal (plans.js); emitted weeks
// still follow the existing Monday alignment. Convert from the target anchor.
// Count ISO calendar days in UTC, independent of local DST-length days. Ceil
// gives 4..20 weeks for 22..140 days; a partial last week extends past the date.
export function trainUntilDuration(value, planningDateLocal = localTodayISO()) {
  if (!value) return { weeks: null, error: '' }
  if (!isValidISODate(value) || !isValidISODate(planningDateLocal)) {
    return { weeks: null, error: 'Choose a valid Train until calendar date.' }
  }
  const days = (Date.parse(`${value}T12:00:00Z`) - Date.parse(`${planningDateLocal}T12:00:00Z`)) / 86400000
  if (days < 0) return { weeks: null, error: 'Train until must be after today.' }
  const weeks = Math.ceil(days / 7)
  if (weeks < 4 || weeks > 20) {
    return { weeks: null, error: 'Choose a Train until date that rounds up to 4–20 weeks from today (22–140 days).' }
  }
  return { weeks, error: '' }
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
  const race = new Date(`${value}T12:00:00Z`)
  const today = new Date(`${localTodayISO()}T12:00:00Z`)
  const days = Math.ceil((race.getTime() - today.getTime()) / 86400000)
  return days >= 0 ? Math.max(1, Math.ceil(days / 7)) : null
}

export default function PlanCatalog() {
  const navigate = useNavigate()
  const location = useLocation()
  const requestedRaceHandledRef = useRef(false)
  const planDialogRef = useRef(null)
  const { isPro, loading: proLoading, error: proError, refreshPro, accessSession } = useProContext()
  const [accessMessage, setAccessMessage] = useState('')
  const [upgradeNeeded, setUpgradeNeeded] = useState(false)
  const searchRequest = useRef(null)
  const generationInFlight = useRef(false)
  const lifetime = useRef(0)
  const todayISO = localTodayISO()
  const [selectedGoal, setSelectedGoal] = useState(null)
  const [prefillLoading, setPrefillLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generationStep, setGenerationStep] = useState('')
  const [error, setError] = useState('')
  const [trainingDays, setTrainingDays] = useState(['Tue', 'Thu', 'Sat'])
  const [liftEligibleWeekdays, setLiftEligibleWeekdays] = useState(DAYS)
  const preferenceEditRevision = useRef(0)
  const prefillRequestRevision = useRef(0)
  const [runDaysPerWeek, setRunDaysPerWeek] = useState(3)
  const [liftingEnabled, setLiftingEnabled] = useState(false)
  const [strengthMode, setStrengthMode] = useState('hybrid_maintain')
  const [liftDaysPerWeek, setLiftDaysPerWeek] = useState(0)
  const [equipmentPreset, setEquipmentPreset] = useState('full_gym')
  const [weeks, setWeeks] = useState('')
  const trainUntilInputRef = useRef(null)
  const [trainUntil, setTrainUntil] = useState('')
  const [trainUntilSubmitError, setTrainUntilSubmitError] = useState('')
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
  const [hyroxSetupOpen, setHyroxSetupOpen] = useState(false)

  const isRacePlan = selectedGoal?.kind === 'race'
  const trainUntilPreview = trainUntilDuration(trainUntil, todayISO)
  const trainUntilError = trainUntilSubmitError || trainUntilPreview.error
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
    if (!proLoading && !proError && isPro) { setAccessMessage(''); setUpgradeNeeded(false) }
  }, [isPro, proLoading, proError])

  const closeOptions = () => {
    if (generationInFlight.current) return
    prefillRequestRevision.current += 1
    setPrefillLoading(false)
    setSelectedGoal(null)
  }

  useEffect(() => {
    const draft = upgradeDraft
    upgradeDraft = null
    if (draft && isAuthSessionCurrent(draft.session)) {
      setSelectedGoal(draft.selectedGoal)
      setRaceDraft(draft.raceDraft)
      setCustomDistance(draft.customDistance)
      setRaceSelection(draft.raceSelection)
      setGoalTime(draft.goalTime)
    }
    const invalidate = () => {
      lifetime.current += 1
      prefillRequestRevision.current += 1
      searchRequest.current?.controller.abort()
      searchRequest.current = null
      setGenerating(false)
      setGenerationStep('')
      setPrefillLoading(false)
      requestedRaceHandledRef.current = false
      generationInFlight.current = null
      setRaceSearchLoading(false)
      setRaceResults([])
      setRaceQuery('')
      setRaceSearchError('')
      setRaceSelection(null)
      setCustomDistance('')
      setGoalTime(0)
      setRaceSearched(false)
      setSavedRaces([])
      setSelectedGoal(null)
      setTrainUntil('')
      setTrainUntilSubmitError('')
      setHyroxSetupOpen(false)
      setRaceDraft({ name: '', date: '', location: '' })
      setAccessMessage('')
      setUpgradeNeeded(false)
      setError('')
    }
    const unsubscribe = subscribeAuthSession(invalidate)
    return () => {
      unsubscribe()
      lifetime.current += 1
      prefillRequestRevision.current += 1
      searchRequest.current?.controller.abort()
      searchRequest.current = null
    }
  }, [])

  useEffect(() => {
    if (!selectedGoal) return undefined
    return activateModalDialog({
      dialog: planDialogRef.current,
      onClose: closeOptions,
    })
  }, [selectedGoal])

  useEffect(() => {
    let active = true
    let revision = 0
    const load = () => {
      const request = ++revision
      const session = getAuthSession()
      if (!session.token) { setSavedRaces([]); return }
      api.get('/races', { forgeAuthSession: session })
        .then(({ data }) => {
          if (!active || request !== revision || !isAuthSessionCurrent(session)) return
          const upcoming = (Array.isArray(data?.races) ? data.races : [])
            .filter((race) => race.status === 'upcoming' && race.race_date >= todayISO && String(race.event_kind || 'run_race') === 'run_race')
            .sort((a, b) => String(a.race_date).localeCompare(String(b.race_date)))
          setSavedRaces(upcoming)
        })
        .catch((err) => {
          if (active && request === revision && isAuthSessionCurrent(session)) console.error('[PlanCatalog] saved race load failed:', err.message)
        })
    }
    load()
    const unsubscribe = subscribeAuthSession(load)
    return () => { active = false; unsubscribe() }
  }, [todayISO])

  const ensurePro = () => {
    if (proLoading || (!proError && !isAuthSessionCurrent(accessSession))) {
      setAccessMessage('Checking Pro access. Please wait, then try again.')
      return false
    }
    if (proError) {
      setAccessMessage(proError)
      return false
    }
    if (isPro !== true) {
      setUpgradeNeeded(true)
      setAccessMessage('Race calendars require Pro. You can enter any race here; upgrade to build its training plan.')
      return false
    }
    setAccessMessage('')
    setUpgradeNeeded(false)
    return true
  }

  const openUpgrade = () => {
    if (isRacePlan) upgradeDraft = {
      session: getAuthSession(), selectedGoal, raceDraft, customDistance, raceSelection, goalTime,
    }
    navigate('/upgrade')
  }

  const accessNotice = (proLoading || proError || accessMessage) && (
    <div role={proError ? 'alert' : 'status'} style={{ padding: 12, margin: '12px 0', background: 'var(--bg-input)', border: '1px solid var(--accent)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 15 }}>
      {proLoading ? 'Checking Pro access… Race entry is available while you wait.' : proError || accessMessage}
      {proError && <button type="button" onClick={() => { setAccessMessage(''); void refreshPro() }} style={{ display: 'block', minHeight: 44 }}>Retry access check</button>}
      {!proLoading && !proError && upgradeNeeded && <button type="button" onClick={openUpgrade} style={{ display: 'block', minHeight: 44 }}>View Pro upgrade</button>}
    </div>
  )

  const loadPrefill = async () => {
    const session = getAuthSession()
    const requestRevision = ++prefillRequestRevision.current
    const editRevision = preferenceEditRevision.current
    setPrefillLoading(true)
    try {
      const { data } = await api.get('/plans/prefill', { forgeAuthSession: session })
      if (!isAuthSessionCurrent(session) || requestRevision !== prefillRequestRevision.current || editRevision !== preferenceEditRevision.current) return
      const inferred = Array.isArray(data?.inferredTrainingDays) && data.inferredTrainingDays.length
        ? data.inferredTrainingDays
        : ['Tue', 'Thu', 'Sat']
      const available = sortDays(inferred)
      const runCount = Number(data?.runDaysPerWeek || 3)
      const liftCount = Number(data?.liftDaysPerWeek || 0)
      setTrainingDays(available)
      setLiftEligibleWeekdays(sortDays(data?.liftEligibleWeekdays || available))
      setRunDaysPerWeek(runCount)
      setLiftingEnabled(Boolean(data?.liftingEnabled))
      setLiftDaysPerWeek(liftCount)
      setStrengthMode('hybrid_maintain')
    } catch (err) {
      if (!isAuthSessionCurrent(session) || requestRevision !== prefillRequestRevision.current) return
      if (err?.response?.status === 402) {
        setUpgradeNeeded(true)
        setAccessMessage('Race calendars require Pro. Upgrade to build your training plan.')
        void refreshPro()
        return
      }
      console.error('[PlanCatalog] prefill failed:', err.message)
      setError(err?.response?.data?.error || 'Could not load your usual training rhythm. You can still edit the plan.')
    } finally {
      if (requestRevision === prefillRequestRevision.current) setPrefillLoading(false)
    }
  }

  const openGoal = async (goal) => {
    if (!ensurePro()) return
    setSelectedGoal(goal)
    setError('')
    setGoalTime(0)
    setWeeks('')
    setTrainUntil('')
    setTrainUntilSubmitError('')
    setCustomDistance(goal.key === 'custom' ? '' : String(goal.distanceMiles))
    setRaceSelection(null)
    setRaceDraft({ name: '', date: '', location: '' })
    await loadPrefill()
  }

  const openRace = async (race = null, selectionType = 'catalog') => {
    if (race && !ensurePro()) return
    if (race && isValidISODate(race.race_date) && race.race_date < localTodayISO()) {
      setAccessMessage('This race date has passed. Enter a future edition manually.')
      return
    }
    prefillRequestRevision.current += 1
    setPrefillLoading(false)
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
    setTrainUntil('')
    setTrainUntilSubmitError('')
    setCustomDistance(race ? String(raceDistance(race)) : '')
    setRaceSelection(race ? { type: selectionType, race } : null)
    setRaceDraft({
      name,
      date: race?.race_date || '',
      location: race ? raceLocation(race) : '',
    })
    if (!proLoading && !proError && isPro) await loadPrefill()
  }

  useEffect(() => {
    const requestedRaceId = location.state?.raceId
    if (proLoading || proError || !requestedRaceId || requestedRaceHandledRef.current || !savedRaces.length) return
    const race = savedRaces.find((item) => String(item.id) === String(requestedRaceId))
    requestedRaceHandledRef.current = true
    navigate(location.pathname, { replace: true, state: null })
    if (race) void openRace(race, 'owned')
    // openRace intentionally runs once for the navigation state handoff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.state?.raceId, navigate, savedRaces, proLoading, proError])

  const searchRaces = async (event) => {
    event.preventDefault()
    const query = raceQuery.trim()
    if (searchRequest.current?.query === query) return
    searchRequest.current?.controller.abort()
    searchRequest.current = null
    setRaceResults([])
    setRaceSearched(true)
    if (query.length < 2) {
      setRaceSearchLoading(false)
      setRaceSearchError('Enter at least two letters from the race name or location.')
      return
    }
    const request = { query, controller: new AbortController(), session: getAuthSession() }
    searchRequest.current = request
    const current = () => searchRequest.current === request && isAuthSessionCurrent(request.session)
    setRaceSearchLoading(true)
    setRaceSearchError('')
    try {
      const { data } = await api.get('/races/catalog', { params: { q: query }, signal: request.controller.signal, forgeAuthSession: request.session })
      if (!current()) return
      setRaceResults(Array.isArray(data?.races) ? data.races.slice(0, 8) : [])
    } catch {
      if (!current()) return
      setRaceSearchError('Race search is unavailable right now. Try Search again or enter your race manually.')
    } finally {
      if (current()) {
        searchRequest.current = null
        setRaceSearchLoading(false)
      }
    }
  }

  const updateRaceDraft = (field, value) => {
    setRaceSelection(null)
    setRaceDraft((current) => ({ ...current, [field]: value }))
  }

  const toggleDay = (day) => {
    preferenceEditRevision.current += 1
    setTrainingDays((prev) => {
      const next = sortDays(prev.includes(day) ? prev.filter((item) => item !== day) : [...prev, day])
      return next
    })
  }

  const generatePlan = async () => {
    if (generationInFlight.current) return
    const goalTimeSeconds = parsedGoalTime
    // Revalidate against the current local date, including a sheet left open overnight.
    const trainUntilNow = trainUntilDuration(trainUntil)
    if (!isRacePlan && (trainUntilNow.error || trainUntilInputRef.current?.validity.badInput)) {
      setTrainUntilSubmitError(trainUntilNow.error || 'Choose a valid Train until calendar date.')
      return
    }
    const parsedWeeks = trainUntil ? trainUntilNow.weeks : Number(weeks)
    const distanceMiles = Number(selectedDistance)
    const runCount = Number(runDaysPerWeek)
    const liftCount = liftingEnabled ? Number(liftDaysPerWeek) : 0

    if (!Number.isFinite(distanceMiles) || distanceMiles < 0.1 || distanceMiles > 100) {
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
    if (!isRacePlan && !trainUntil && weeks && (!Number.isInteger(parsedWeeks) || parsedWeeks < 4 || parsedWeeks > 20)) {
      setError('Weeks must be a whole number from 4 to 20.')
      return
    }
    if (!trainingDays.length) {
      setError('Choose at least one available training day.')
      return
    }
    if (!Number.isInteger(runCount) || runCount < 1 || runCount > 7 || runCount > trainingDays.length) {
      setError('Run days must be a whole number from 1 to 7 and fit inside your eligible weekdays.')
      return
    }
    if (liftingEnabled && (!Number.isInteger(liftCount) || liftCount < 1 || liftCount > 7 || liftCount > liftEligibleWeekdays.length)) {
      setError('Lift days must be a whole number from 1 to 7 and fit inside your eligible lifting weekdays.')
      return
    }

    setError('')
    if (!ensurePro()) return
    const session = getAuthSession()
    const revision = lifetime.current
    const current = () => isAuthSessionCurrent(session) && lifetime.current === revision
    const config = { forgeAuthSession: session }
    const operation = {}
    generationInFlight.current = operation
    setGenerating(true)
    setGenerationStep(isRacePlan ? 'Saving race...' : 'Building your calendar...')
    setError('')
    let savedRaceThisAttempt = false
    try {
      const target = {
        distanceMiles,
        trainingDays,
        runEligibleWeekdays: trainingDays,
        liftEligibleWeekdays,
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
            catalogRaceOptions, config,
          )
          if (!current()) return
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
          }, config)
          if (!current()) return
          ownedRace = data?.race
        }
        const requestedGoalTime = goalTimeSeconds || null
        if (ownedRace && raceSelection?.type === 'owned' && Number(ownedRace.goal_time_seconds || 0) !== Number(requestedGoalTime || 0)) {
          const { data } = await api.patch(`/races/${encodeURIComponent(ownedRace.id)}`, { goal_time_seconds: requestedGoalTime }, config)
          if (!current()) return
          ownedRace = data?.race || ownedRace
        }
        if (!ownedRace?.id) throw new Error('Race could not be saved before plan generation.')
        savedRaceThisAttempt = true
        setRaceSelection({ type: 'owned', race: ownedRace })
        setGenerationStep('Building your race calendar...')
        await previewAndApplyPlan(
          `/plans/generate-for-race/${encodeURIComponent(ownedRace.id)}`,
          { target },
          { ...config, timeout: PLAN_GENERATION_TIMEOUT_MS },
        )
      } else {
        if (trainUntil || weeks) target.weeks = parsedWeeks
        setGenerationStep('Building your calendar...')
        await previewAndApplyPlan('/plans/generate', { target }, { ...config, timeout: PLAN_GENERATION_TIMEOUT_MS })
      }
      if (current()) navigate('/plan')
    } catch (err) {
      if (!current()) return
      if (isPlanCandidateReviewCancelled(err)) {
        setError(`${savedRaceThisAttempt ? 'Your race was saved. ' : ''}Your current training plan was kept. No plan calendar changes were made.`)
        return
      }
      if (err?.response?.status === 402) {
        setUpgradeNeeded(true)
        setAccessMessage('Race calendars require Pro. Upgrade to build your training plan; your race details are kept here.')
        void refreshPro()
        return
      }
      console.error('[PlanCatalog] plan generation failed:', err.message)
      if (err?.code === 'ECONNABORTED') {
        setError(`${savedRaceThisAttempt ? 'Your race was saved, but your training plan was not changed. ' : ''}The plan preview took too long. You can retry using the saved race.`)
      } else {
        setError(`${savedRaceThisAttempt ? 'Your race was saved, but your training plan was not changed. ' : ''}${err?.response?.data?.error || err?.message || 'Unable to generate this plan right now.'}`)
      }
    } finally {
      if (generationInFlight.current === operation) generationInFlight.current = null
      if (!current()) return
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
          Request a calendar for your race. If the current planner cannot cover the full period or verify required training data, it will explain why and keep your active plan.
        </p>
      </header>

      {!selectedGoal && accessNotice}
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
              disabled={proLoading}
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
            placeholder="Race name or city, state"
            aria-label="Search race catalog"
            style={{ flex: '1 1 230px', minWidth: 0, background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', fontSize: 16 }}
          />
          <button type="submit" disabled={raceSearchLoading} className="rounded-lg px-4 py-3 font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', opacity: raceSearchLoading ? 0.65 : 1 }}>
            {raceSearchLoading ? 'Searching...' : 'Search'}
          </button>
          <button type="button" onClick={() => openRace()} className="rounded-lg px-4 py-3 font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
            Enter your race manually
          </button>
        </form>

        {(raceSearchLoading || raceSearchError || raceSearched) && (
          <p role={raceSearchError ? 'alert' : 'status'} aria-live="polite" style={{ color: 'var(--text-primary)', background: 'var(--bg-input)', border: `1px solid ${raceSearchError ? 'var(--danger)' : 'var(--accent)'}`, borderRadius: 8, padding: 14, fontSize: 16, fontWeight: 750, marginTop: 12 }}>
            {raceSearchLoading ? 'Searching the race catalog…' : raceSearchError || (raceResults.length
              ? `${raceResults.length === 8 ? 'Showing up to 8' : raceResults.length} matching race${raceResults.length === 1 ? '' : 's'}. Check the date before choosing.`
              : 'No matching races found. Enter your race manually with any name, date and distance.')}
          </p>
        )}
        {raceResults.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10, marginTop: 14 }}>
            {raceResults.map((race) => {
              const course = race.course_intelligence
              const past = isValidISODate(race.race_date) && race.race_date < todayISO
              return (
                <article key={race.id} className="rounded-lg p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', minWidth: 0 }}>
                  <p style={{ color: 'var(--text-primary)', fontSize: 15, fontWeight: 950, margin: 0, overflowWrap: 'anywhere' }}>{raceName(race)}</p>
                  <p style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 850, margin: '5px 0 0' }}>{formatRaceDate(race.race_date)} · {raceDistance(race)} mi</p>
                  <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 5 }}><MapPin size={12} /> {raceLocation(race) || 'Location not listed'}</p>
                  {course && <p style={{ color: course.trusted ? 'var(--success)' : 'var(--text-muted)', fontSize: 11, fontWeight: 850, margin: '7px 0 0' }}>{course.label}</p>}
                  {past && <p style={{ color: 'var(--text-primary)', fontSize: 14, fontWeight: 850 }}>Past race — enter a new date manually to plan a future edition.</p>}
                  <button type="button" disabled={proLoading || past} onClick={() => openRace(race)} className="rounded-lg px-3 py-2" style={{ marginTop: 10, width: '100%', background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', fontSize: 13, fontWeight: 950 }}>
                    {past ? 'Past race' : proLoading ? 'Checking Pro access…' : 'Use this race'}
                  </button>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section aria-labelledby="hyrox-plan-choice" style={{ marginBottom: 22 }}>
        <h2 id="hyrox-plan-choice" style={{ color: 'var(--text-primary)', fontSize: 18, fontWeight: 950, margin: '0 0 4px' }}>Training for HYROX?</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 12px' }}>Build a running-first worldwide HYROX plan around an exact event date, or start with an eight-week foundation block.</p>
        <button
          type="button"
          onClick={() => { if (ensurePro()) setHyroxSetupOpen(true) }}
          className="rounded-lg p-4"
          style={{ width: '100%', maxWidth: 560, minWidth: 0, minHeight: 110, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, textAlign: 'left', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--accent)' }}
        >
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 23, fontWeight: 950 }}>HYROX</span>
            <span style={{ display: 'block', marginTop: 5, color: 'var(--text-muted)', fontSize: 13, overflowWrap: 'anywhere' }}>Exact station order · equipment-aware · adaptive runway</span>
          </span>
          <ChevronRight size={22} color="var(--accent)" style={{ flex: '0 0 auto' }} />
        </button>
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

      {hyroxSetupOpen && (
        <HyroxPlanSetup
          savedRaces={savedRaces}
          onClose={() => setHyroxSetupOpen(false)}
          onComplete={() => navigate('/plan')}
        />
      )}

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
              <button type="button" disabled={generating} onClick={closeOptions} aria-label="Close plan options" style={{ flex: '0 0 auto', width: 38, height: 38, display: 'grid', placeItems: 'center', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 8, color: 'var(--text-primary)' }}>
                <X size={18} />
              </button>
            </div>

            {accessNotice}
            {prefillLoading && <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>Loading your usual training rhythm...</p>}
            {error && <div role="alert" className="rounded-lg p-3" style={{ background: 'var(--danger-dim)', border: '1px solid var(--danger-dim)', color: 'var(--danger)', fontSize: 13, fontWeight: 700, marginBottom: 12 }}>{error}</div>}

            <fieldset disabled={generating} style={{ display: 'grid', gap: 16, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              {isRacePlan && (
                <section aria-label="Race details" style={{ display: 'grid', gap: 12 }}>
                  <label style={{ display: 'grid', gap: 7 }}>
                    <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Race name</span>
                    <input value={raceDraft.name} onChange={(event) => updateRaceDraft('name', event.target.value)} placeholder="Race or event name" maxLength={200} style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', fontSize: 16 }} />
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                    <div style={{ display: 'grid', gap: 7 }}>
                      <label htmlFor="manual-race-date" style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850, display: 'flex', alignItems: 'center', gap: 6 }}><CalendarDays size={15} color="var(--accent)" /> Race date</label>
                      <input id="manual-race-date" aria-describedby="manual-race-date-help" type="date" min={todayISO} value={raceDraft.date} onChange={(event) => updateRaceDraft('date', event.target.value)} style={{ minHeight: 44, width: '100%', boxSizing: 'border-box', minWidth: 0, background: 'var(--bg-input)', color: 'var(--text-primary)', colorScheme: 'dark', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '11px 12px', fontSize: 16 }} />
                      <span id="manual-race-date-help" style={{ color: 'var(--text-muted)', fontSize: 12 }}>Select race date</span>
                    </div>
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
                  <select value={runDaysPerWeek} onChange={(event) => { preferenceEditRevision.current += 1; setRunDaysPerWeek(Number(event.target.value)) }} style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', fontSize: 15 }}>
                    {Array.from({ length: 7 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count} run day{count === 1 ? '' : 's'}</option>)}
                  </select>
                </label>
                {liftingEnabled && (
                  <label style={{ display: 'grid', gap: 7 }}>
                    <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Lift days each week</span>
                    <select value={Math.max(1, liftDaysPerWeek)} onChange={(event) => { preferenceEditRevision.current += 1; setLiftDaysPerWeek(Number(event.target.value)) }} style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', fontSize: 15 }}>
                      {Array.from({ length: 7 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count} lift day{count === 1 ? '' : 's'}</option>)}
                    </select>
                  </label>
                )}
              </div>

              {liftingEnabled && <section aria-label="Eligible lifting weekdays">
                <p style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Eligible lifting weekdays</p>
                <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>Lifts use these weekdays. A run and lift may share a day when both are selected.</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6 }}>
                  {DAYS.map((day) => <button key={day} type="button" aria-label={`Lift ${day}`} aria-pressed={liftEligibleWeekdays.includes(day)} onClick={() => {
                    preferenceEditRevision.current += 1
                    setLiftEligibleWeekdays((current) => sortDays(current.includes(day) ? current.filter((value) => value !== day) : [...current, day]))
                  }} style={{ minHeight: 44, minWidth: 0, borderRadius: 8, border: '1px solid var(--border-subtle)', background: liftEligibleWeekdays.includes(day) ? 'var(--accent-dim)' : 'var(--bg-input)', color: 'var(--text-primary)' }}>{day}</button>)}
                </div>
              </section>}

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
                  <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
                    <label htmlFor="block-train-until" style={{ display: 'grid', gap: 8 }}>
                      <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Train until (optional)</span>
                      <input ref={trainUntilInputRef} id="block-train-until" type="date" value={trainUntil}
                        aria-describedby="block-train-until-help block-train-until-preview"
                        aria-invalid={Boolean(trainUntilError)}
                        onChange={(event) => { setTrainUntil(event.target.value); setTrainUntilSubmitError(event.target.validity.badInput ? 'Choose a valid Train until calendar date.' : '') }}
                        style={{ minHeight: 44, minWidth: 0, width: '100%', boxSizing: 'border-box', background: 'var(--bg-input)', color: 'var(--text-primary)', colorScheme: 'dark', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '11px 12px', fontSize: 16 }} />
                    </label>
                    <p id="block-train-until-help" style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}>Select a date or leave blank to use Weeks. From today, calendar days round up to whole weeks (4–20). The calendar end can differ from this date.</p>
                    <div id="block-train-until-preview" aria-live="polite" style={{ fontSize: 13, color: trainUntilError ? 'var(--danger)' : 'var(--text-primary)' }}>
                      {trainUntilError ? <span role="alert">{trainUntilError}</span> : trainUntilPreview.weeks ? `${trainUntilPreview.weeks} weeks from today (rounded up).` : ''}
                    </div>
                    {trainUntil && <button type="button" onClick={() => { setTrainUntil(''); setTrainUntilSubmitError('') }} style={{ minHeight: 44 }}>Clear Train until</button>}
                    <label style={{ display: 'grid', gap: 8 }}>
                      <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Weeks</span>
                      <input type="number" min="4" max="20" value={weeks} disabled={Boolean(trainUntil)} onChange={(event) => setWeeks(event.target.value)} placeholder="optional" inputMode="numeric" style={{ minWidth: 0, background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', fontSize: 16 }} />
                    </label>
                  </div>
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
                          preferenceEditRevision.current += 1
                          setLiftingEnabled(enabled)
                          if (enabled) {
                            setStrengthMode(option.mode)
                            const preferred = option.mode === 'hybrid_build' ? 3 : 2
                            setLiftDaysPerWeek((current) => Number(current) > 0 ? Number(current) : preferred)
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

              <button type="button" onClick={generatePlan} disabled={generating || prefillLoading || proLoading} className="rounded-lg p-4" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', fontSize: 15, fontWeight: 950, opacity: generating || prefillLoading ? 0.65 : 1 }}>
                {proLoading ? 'Checking Pro access…' : generating ? generationStep || 'Generating...' : isRacePlan ? 'Build Race Calendar' : 'Generate Training Block'}
              </button>
            </fieldset>
          </div>
        </div>
      )}
    </div>
  )
}
