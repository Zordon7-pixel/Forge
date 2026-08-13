import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ChevronDown, ChevronUp } from 'lucide-react'
import api from '../lib/api'
import { previewAndApplyPlan } from '../lib/planCandidates'
import { isPlanCandidateReviewCancelled } from '../lib/planCandidateReview'
import { useProContext } from '../context/ProContext'
import ProGate from '../components/ProGate'
import AiGuidanceNote from '../components/AiGuidanceNote'
import ForgedCalendar from '../components/calendar/ForgedCalendar'
import ForgedDayView from '../components/calendar/ForgedDayView'
import RaceEditSheet from '../components/calendar/RaceEditSheet'
import {
  buildCalendarModel, calendarDateRange, dayWithRecordedRuns, goalWithRace, indexRecordedRuns, racePlanReview,
  deriveForwardOnlyPlanWeek, derivePlanWeekSyncTarget, resolvePlanWeekSelection, todayISO,
} from '../lib/planCalendar'
import { withActiveRunReturnTarget } from '../lib/activeRunControls'
import { resolveReadiness } from '../lib/truthConsistency'
import { deriveRacePlanReconciliation } from '../lib/travelTraining'
import { removeScheduledWorkout } from '../lib/selfServiceRemoval'
import TravelTrainingPrompt from '../components/TravelTrainingPrompt'
import {
  buildScheduleRebuildRequest,
  protectedRaceIdsFromGoals,
  scheduleDraftFromPlan,
  scheduleFrequencyGuidance,
  scheduleHasChanges,
  shouldRefreshScheduleDraft,
  toggleTrainingDay,
  TRAINING_DAY_OPTIONS,
  validateScheduleDraft,
} from '../lib/planSchedule'

const RoutePlanner = lazy(() => import('../components/RoutePlanner'))

function executionFromCalendar(model, dateISO, completedSet) {
  if (!model) return null
  const day = model.findDayByDate(dateISO)
  if (!day) return { hasPlan: true, hasDay: false, isRest: false, date: dateISO, sessions: [], run: null, lift: null }
  const sessions = (day.sessions || []).map((session) => ({
    ...(session.prescription || {}),
    ...(session.raw || {}),
    id: String(session.id),
    kind: session.kind,
    type: session.type,
    title: session.title,
    distance_miles: session.distanceMiles,
    duration_min: session.durationMinutes,
    completed: completedSet?.has(String(session.id))
      || session.completed === true
      || session.raw?.completed === true
      || String(session.raw?.status || '').toLowerCase() === 'completed',
  }))
  return {
    hasPlan: true,
    hasDay: true,
    isRest: sessions.length === 0,
    date: day.dateISO,
    day: day.dayLabel,
    week: Number.isInteger(day.weekIndex) ? day.weekIndex + 1 : null,
    phase: day.phase || null,
    goal: model.goal || null,
    sessions,
    run: sessions.find((session) => session.kind === 'run') || null,
    lift: sessions.find((session) => session.kind === 'lift') || null,
  }
}

function formatRaceDate(race) {
  const match = String(race?.race_date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return race?.race_date || 'date unavailable'
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

function RacePlanReconciliationCard({ candidate, busy, error, onAdd, onReview }) {
  if (!candidate) return null
  const direct = candidate.kind === 'direct'
  return (
    <section aria-labelledby="race-plan-reconciliation-title" className="min-w-0 rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--accent)' }}>
      <p className="text-[10px] font-black uppercase" style={{ color: 'var(--accent)', margin: 0 }}>
        {direct ? 'Race not in this plan' : 'Race plan review'}
      </p>
      <h2 id="race-plan-reconciliation-title" className="mt-1 break-words text-lg font-black" style={{ color: 'var(--text-primary)' }}>
        {direct
          ? `Add ${candidate.missingRace.race_name} to your ${candidate.protectedRace.race_name} plan?`
          : 'Review which upcoming races this plan should protect'}
      </h2>
      <p className="mt-1 break-words text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
        {direct
          ? `${formatRaceDate(candidate.orderedRaces[0])} and ${formatRaceDate(candidate.orderedRaces[1])}. One plan will protect both peaks.`
          : candidate.reason === 'close_dates'
            ? 'These races are less than 21 days apart. Review them before choosing how the calendar should handle recovery and tapering.'
            : 'More than one eligible saved race is outside this plan, so Forged Hybrid will not guess which pair to use.'}
      </p>
      {error && <p role="alert" aria-live="assertive" className="mt-3 break-words rounded-lg p-3 text-sm" style={{ background: 'var(--danger-dim)', color: 'var(--danger)' }}>{error}</p>}
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {direct && (
          <button type="button" onClick={onAdd} disabled={busy} className="min-h-11 rounded-lg px-4 py-3 text-sm font-black disabled:opacity-60" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
            {busy ? 'Adding to plan…' : 'Add to this plan'}
          </button>
        )}
        <button type="button" onClick={onReview} disabled={busy} className="min-h-11 rounded-lg px-4 py-3 text-sm font-bold disabled:opacity-60" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
          Review races
        </button>
      </div>
    </section>
  )
}

export default function Plan() {
  const navigate = useNavigate()
  const { isPro, loading: proLoading } = useProContext()
  const [myPlan, setMyPlan] = useState(null)
  const [myUserPlan, setMyUserPlan] = useState(null)
  const [adaptationProposal, setAdaptationProposal] = useState(null)
  const [adaptationLoading, setAdaptationLoading] = useState(false)
  const [adaptationError, setAdaptationError] = useState('')
  const [adaptationNotice, setAdaptationNotice] = useState('')
  const [adaptationDecision, setAdaptationDecision] = useState(null)
  const [decidingAdaptation, setDecidingAdaptation] = useState(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [selectedDayISO, setSelectedDayISO] = useState(null)
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(null)
  const [manageOpen, setManageOpen] = useState(false)
  const [adaptationOpen, setAdaptationOpen] = useState(false)
  const [routePlannerStatus, setRoutePlannerStatus] = useState({ available: false, requiresPro: false })
  const [races, setRaces] = useState([])
  const [runs, setRuns] = useState([])
  const [raceEditorOpen, setRaceEditorOpen] = useState(false)
  const [raceSaving, setRaceSaving] = useState(false)
  const [raceSaveError, setRaceSaveError] = useState('')
  const [raceSaveNotice, setRaceSaveNotice] = useState(null)
  const [planReviewBusy, setPlanReviewBusy] = useState(false)
  const [planReviewError, setPlanReviewError] = useState('')
  const [reconcilingRaces, setReconcilingRaces] = useState(false)
  const [raceReconciliationError, setRaceReconciliationError] = useState('')
  const [raceReconciliationNotice, setRaceReconciliationNotice] = useState('')
  const [travelCheckin, setTravelCheckin] = useState(null)
  const [travelReadinessData, setTravelReadinessData] = useState(null)
  const [travelActiveInjury, setTravelActiveInjury] = useState(null)
  const [travelInjurySafetyAvailable, setTravelInjurySafetyAvailable] = useState(false)
  const [scheduleEditing, setScheduleEditing] = useState(false)
  const [scheduleDraft, setScheduleDraft] = useState(() => scheduleDraftFromPlan())
  const [scheduleSaving, setScheduleSaving] = useState(false)
  const [scheduleError, setScheduleError] = useState('')
  const [scheduleNotice, setScheduleNotice] = useState('')
  const [removingSessionId, setRemovingSessionId] = useState(null)
  const [sessionRemovalError, setSessionRemovalError] = useState('')
  const [sessionRemovalNotice, setSessionRemovalNotice] = useState('')
  const weekSyncInFlight = useRef(null)
  const currentPlanCalendarRef = useRef(null)

  const openCurrentPlan = () => {
    const target = currentPlanCalendarRef.current
    if (!target) return
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    target.focus({ preventScroll: true })
    target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
  }

  const loadAll = async ({ includeAdaptation = true } = {}) => {
    setLoading(true)
    setAdaptationError('')
    try {
      const myRes = await api.get('/plans/my')
      const nextPlan = myRes.data?.plan || null
      const nextUserPlan = myRes.data?.user_plan || null
      setMyPlan(nextPlan)
      setMyUserPlan(nextUserPlan)
      const nextCalendar = nextPlan ? buildCalendarModel(nextPlan, nextUserPlan) : null
      const runDateRange = calendarDateRange(nextCalendar, todayISO())
      const [racesRes, runsRes, checkinRes, injuryRes, readinessRes] = await Promise.all([
        api.get('/races').catch((err) => {
          console.error('[Plan] race list load failed:', err?.message || err)
          return null
        }),
        api.get('/runs', { params: runDateRange ? { ...runDateRange, limit: 500 } : { limit: 50 } }).catch((err) => {
          console.error('[Plan] recorded runs load failed:', err?.message || err)
          return null
        }),
        api.get('/checkin/today', { params: { date: todayISO() } }).catch((err) => {
          console.error('[Plan] travel check-in load failed:', err?.message || err)
          return { data: null }
        }),
        api.get('/injury/active').catch((err) => {
          console.error('[Plan] injury safety load failed:', err?.message || err)
          return { data: { injuries: [], safetyUnavailable: true } }
        }),
        api.get('/recovery/readiness').catch((err) => {
          console.error('[Plan] readiness safety load failed:', err?.message || err)
          return { data: null }
        }),
      ])
      if (racesRes) setRaces(Array.isArray(racesRes.data?.races) ? racesRes.data.races : [])
      if (runsRes) setRuns(Array.isArray(runsRes.data) ? runsRes.data : Array.isArray(runsRes.data?.runs) ? runsRes.data.runs : [])
      setTravelCheckin(checkinRes.data || null)
      setTravelActiveInjury((injuryRes.data?.injuries || [])[0] || null)
      setTravelInjurySafetyAvailable(injuryRes.data?.safetyUnavailable !== true)
      setTravelReadinessData(readinessRes.data || null)
      let loadedAdaptationProposal = null
      let adaptationLoaded = false
      if (includeAdaptation) setAdaptationProposal(null)
      const isSchemaV2 = Number(nextPlan?.plan_data?.schemaVersion || 0) === 2
      if (isSchemaV2 && includeAdaptation) {
        setAdaptationLoading(true)
        try {
          const adaptationRes = await api.get('/plans/adaptation/current', { params: { date: todayISO() } })
          loadedAdaptationProposal = adaptationRes.data?.proposal || null
          adaptationLoaded = true
          setAdaptationProposal(loadedAdaptationProposal)
        } catch (err) {
          setAdaptationProposal(null)
          setAdaptationError(err?.response?.data?.error || 'Transparent adjustment is not available right now.')
        } finally {
          setAdaptationLoading(false)
        }
      } else {
        setAdaptationLoading(false)
      }
      return {
        plan: nextPlan,
        userPlan: nextUserPlan,
        adaptationLoaded,
        adaptationProposal: loadedAdaptationProposal,
      }
    } catch (err) {
      console.error('[Plan] failed to load active plan:', err?.message || err)
      return null
    } finally {
      setLoading(false)
      setAdaptationLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!shouldRefreshScheduleDraft({ editing: scheduleEditing, saving: scheduleSaving })) return
    setScheduleDraft(scheduleDraftFromPlan(myPlan?.plan_data))
  }, [myPlan, scheduleEditing, scheduleSaving])

  useEffect(() => {
    if (!adaptationProposal?.id) return
    const hasPendingChanges = adaptationProposal.status === 'proposal'
      && (adaptationProposal.changes || []).length > 0
      && !['kept', 'accepted'].includes(adaptationProposal.decisionStatus)
    setAdaptationOpen(Boolean(adaptationProposal.safetyException || hasPendingChanges))
  }, [adaptationProposal])

  useEffect(() => {
    let active = true
    api.get('/routes/planner-status')
      .then((response) => {
        if (!active) return
        setRoutePlannerStatus({
          available: Boolean(response.data?.available),
          requiresPro: Boolean(response.data?.requiresPro),
        })
      })
      .catch((err) => {
        console.error('[Plan] route planner availability check failed:', err?.message || err)
      })
    return () => { active = false }
  }, [])

  const today = todayISO()
  const completedSet = useMemo(
    () => new Set((myUserPlan?.progress?.completedSessionIds || []).map(String)),
    [myUserPlan],
  )

  const model = useMemo(
    () => (myPlan ? buildCalendarModel(myPlan, myUserPlan) : null),
    [myPlan, myUserPlan],
  )
  const weekIndex = myPlan
    ? resolvePlanWeekSelection(myPlan, myUserPlan, selectedWeekIndex)
    : 0
  const currentWeek = weekIndex + 1
  const completionCurrentWeek = myPlan
    ? deriveForwardOnlyPlanWeek(myPlan, myUserPlan)
    : 1

  useEffect(() => {
    const syncWeek = derivePlanWeekSyncTarget(myPlan, myUserPlan)
    if (!syncWeek || weekSyncInFlight.current === syncWeek) return
    weekSyncInFlight.current = syncWeek
    api.put('/plans/my/progress', { current_week: syncWeek })
      .then((response) => {
        const persistedWeek = Number(response.data?.current_week || syncWeek)
        const completedSessionIds = response.data?.completedSessionIds
        setMyUserPlan((current) => current ? {
          ...current,
          current_week: persistedWeek,
          ...(Array.isArray(completedSessionIds) ? {
            progress: { ...(current.progress || {}), completedSessionIds },
          } : {}),
        } : current)
      })
      .catch((err) => console.error('[Plan] current week sync failed:', err?.message || err))
      .finally(() => {
        if (weekSyncInFlight.current === syncWeek) weekSyncInFlight.current = null
      })
  }, [myPlan, myUserPlan])
  const recordedRunsByDate = useMemo(() => indexRecordedRuns(runs), [runs])
  const findRaceForGoal = (goal) => {
    if (!goal) return null
    if (goal.raceId) {
      const exact = races.find((race) => String(race.id) === String(goal.raceId))
      if (exact) return exact
    }
    const normalizedGoalName = String(goal.name || '').trim().toLowerCase()
    return races.find((race) => (
      race.race_date === goal.dateISO
      && String(race.race_name || '').trim().toLowerCase() === normalizedGoalName
      && (!goal.distanceMiles || Math.abs(Number(race.distance_miles || 0) - Number(goal.distanceMiles)) < 0.01)
    )) || null
  }
  const activeRaces = useMemo(
    () => (model?.goals?.length ? model.goals : [model?.goal]).map(findRaceForGoal).filter(Boolean),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, races],
  )
  const activeRace = activeRaces[activeRaces.length - 1] || null
  const racePlanReviews = useMemo(() => {
    const goals = model?.goals?.length ? model.goals : model?.goal ? [model.goal] : []
    return goals.map((goal) => {
      const race = findRaceForGoal(goal)
      return { goal, race, review: racePlanReview(goal, race) }
    }).filter((entry) => entry.race && entry.review.required)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, races])
  const calendarModel = useMemo(() => (
    model ? {
      ...model,
      goal: activeRace ? goalWithRace(model.goal, activeRace) : model.goal,
      goals: (model.goals || []).map((goal) => {
        const race = findRaceForGoal(goal)
        return race ? goalWithRace(goal, race) : goal
      }),
    } : model
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [model, activeRace, races])
  const racePlanReconciliation = useMemo(() => deriveRacePlanReconciliation({
    calendarGoals: model?.goals?.length ? model.goals : model?.goal ? [model.goal] : [],
    savedRaces: races,
    todayISO: today,
  }), [model, races, today])
  const travelExecution = useMemo(
    () => executionFromCalendar(calendarModel, today, completedSet),
    [calendarModel, today, completedSet],
  )
  const hasRunRecordedToday = useMemo(
    () => Boolean(recordedRunsByDate.get(today)?.length),
    [recordedRunsByDate, today],
  )
  const travelReadiness = useMemo(() => ({
    ...resolveReadiness(travelReadinessData),
    band: travelReadinessData?.band || null,
  }), [travelReadinessData])
  const isActiveSchemaV2 = Number(myPlan?.plan_data?.schemaVersion || 0) === 2
  const weekCount = Number(myPlan?.weeks || calendarModel?.weekCount || 0)
  const planReviewRequired = myUserPlan?.progress?.planReviewRequired
    || myPlan?.plan_data?.planReviewRequired
    || null
  const currentWeekConstraint = currentWeek === 1
    ? myPlan?.plan_data?.weeks?.[0]?.currentWeekConstraint
    : null

  // Derive the selected day from the live model so completion toggles stay fresh
  // across reloads (we store the ISO date, not a stale day object).
  const selectedDay = useMemo(
    () => (selectedDayISO && calendarModel
      ? dayWithRecordedRuns(calendarModel.findDayByDate(selectedDayISO), selectedDayISO, recordedRunsByDate)
      : null),
    [selectedDayISO, calendarModel, recordedRunsByDate],
  )
  const selectedRunSession = useMemo(
    () => selectedDay?.sessions?.find((session) => session.kind === 'run') || null,
    [selectedDay],
  )
  const routePlannerWorkout = useMemo(() => {
    if (!selectedRunSession) return null
    const prescription = selectedRunSession.prescription || {}
    return {
      distanceMiles: Number(selectedRunSession.distanceMiles || prescription.distance_miles || prescription.distanceMiles || 0),
      rawType: prescription.workout_type || selectedRunSession.type || 'run',
      typeLabel: selectedRunSession.title || 'Scheduled run',
    }
  }, [selectedRunSession])
  const selectedPhase = useMemo(() => {
    if (!selectedDay || !calendarModel || !Number.isInteger(selectedDay.weekIndex)) return null
    return calendarModel.phaseForWeek(selectedDay.weekIndex)
  }, [selectedDay, calendarModel])
  const selectedWeek = useMemo(() => {
    if (!selectedDay || !calendarModel || !Number.isInteger(selectedDay.weekIndex)) return null
    return calendarModel.getWeek(selectedDay.weekIndex)
  }, [selectedDay, calendarModel])

  const toggleSession = async (sessionId) => {
    if (!sessionId) return
    const isCompleted = completedSet.has(String(sessionId))
    setUpdating(true)
    try {
      await api.put('/plans/my/progress', isCompleted
        ? { unset_session_id: sessionId, current_week: completionCurrentWeek }
        : { completed_session_id: sessionId, current_week: completionCurrentWeek })
      await loadAll()
    } finally {
      setUpdating(false)
    }
  }

  const removePlanSession = async (session) => {
    const removalSessionId = String(session?.removalSessionId || '')
    if (!removalSessionId || removingSessionId) return
    const label = session.title || 'this workout'
    if (!window.confirm(`Remove ${label} from this training plan? Recorded workouts and health history will stay intact.`)) return
    setRemovingSessionId(removalSessionId)
    setSessionRemovalError('')
    setSessionRemovalNotice('')
    try {
      const data = await removeScheduledWorkout({ api, sessionId: removalSessionId })
      const removedSessionIds = Array.isArray(data?.removedSessionIds) ? data.removedSessionIds.map(String) : []
      if (!removedSessionIds.includes(removalSessionId)) {
        throw new Error('Forge did not return confirmation for this workout removal.')
      }
      const refreshed = await loadAll({ includeAdaptation: false })
      if (!refreshed) throw new Error('Forge could not confirm the final plan state.')
      const confirmedIds = (refreshed?.userPlan?.progress?.removedSessionIds || []).map(String)
      if (!confirmedIds.includes(removalSessionId)) {
        throw new Error('Forge did not confirm the workout removal after refreshing the plan.')
      }
      setSessionRemovalNotice(`${label} was removed from the plan. Recorded training and health history were preserved.`)
    } catch (err) {
      console.error('[Plan] scheduled workout removal failed:', err?.message || err)
      const reason = err?.response?.data?.error || err?.message || `Could not remove ${label}.`
      try {
        const refreshed = await loadAll({ includeAdaptation: false })
        if (!refreshed) {
          setSessionRemovalError(`${reason} Forge could not confirm the final plan state. Refresh before trying again.`)
          return
        }
        const confirmedIds = (refreshed?.userPlan?.progress?.removedSessionIds || []).map(String)
        if (confirmedIds.includes(removalSessionId)) {
          setSessionRemovalNotice(`${label} was removed from the plan. Forge confirmed it after refreshing your account.`)
          return
        }
        setSessionRemovalError(`${reason} The workout is still listed, and the removal stopped. Refresh and try again.`)
      } catch (confirmationError) {
        console.error('[Plan] scheduled workout removal confirmation failed:', confirmationError?.message || confirmationError)
        setSessionRemovalError(`${reason} Forge could not confirm the final plan state. Refresh before trying again.`)
      }
    } finally {
      setRemovingSessionId(null)
    }
  }

  const goToWeek = (nextWeek) => {
    const nextIndex = Math.max(0, Math.min((weekCount || 1) - 1, Number(nextWeek) - 1))
    setSelectedWeekIndex(nextIndex)
  }

  const addRaceToPlan = async () => {
    if (racePlanReconciliation?.kind !== 'direct' || reconcilingRaces) return
    setReconcilingRaces(true)
    setRaceReconciliationError('')
    setRaceReconciliationNotice('')
    try {
      await previewAndApplyPlan('/plans/generate-for-races', {
        race_ids: racePlanReconciliation.orderedRaceIds,
      })
      setScheduleError('')
      setPlanReviewError('')
      setRaceReconciliationNotice('Both race peaks are now protected in one plan.')
      await loadAll()
    } catch (err) {
      if (isPlanCandidateReviewCancelled(err)) {
        setRaceReconciliationNotice('Your current plan was kept. No calendar changes were made.')
        return
      }
      setRaceReconciliationError(err?.response?.data?.error || 'Could not add this race to the plan. Your current plan is unchanged.')
    } finally {
      setReconcilingRaces(false)
    }
  }

  const rebuildRacePlan = async () => {
    if (!racePlanReviews.length || planReviewBusy) return
    const goals = model?.goals?.length ? model.goals : model?.goal ? [model.goal] : []
    const raceIds = goals.map((goal) => findRaceForGoal(goal)?.id).filter(Boolean)
    if (!raceIds.length || raceIds.length !== goals.length) {
      setPlanReviewError('Review the saved races before rebuilding this calendar.')
      return
    }
    const planData = myPlan?.plan_data || {}
    const strengthPolicy = planData.strengthPolicy || {}
    setPlanReviewBusy(true)
    setPlanReviewError('')
    try {
      await previewAndApplyPlan('/plans/generate-for-races', {
        race_ids: raceIds,
        target: {
          trainingDays: planData.schedulePreferences?.trainingDays || [],
          runDaysPerWeek: planData.schedulePreferences?.runDaysPerWeek || null,
          planMode: planData.planMode || 'run_only',
          liftingEnabled: Boolean(strengthPolicy.enabled),
          liftDaysPerWeek: strengthPolicy.sessionsPerWeek || 0,
          strengthGoal: strengthPolicy.goal || 'maintain',
          equipment: Array.isArray(strengthPolicy.equipment) ? strengthPolicy.equipment : [],
        },
      }, { timeout: 90000 })
      setScheduleError('')
      setRaceReconciliationError('')
      setRaceSaveNotice({ message: 'Training calendar rebuilt for the updated race target.' })
      await loadAll()
    } catch (err) {
      if (isPlanCandidateReviewCancelled(err)) {
        setRaceSaveNotice({ message: 'Your current plan was kept. No calendar changes were made.' })
        return
      }
      console.error('[Plan] race plan rebuild failed:', err?.message || err)
      setPlanReviewError(err?.response?.data?.error || 'Could not rebuild this race plan. Your current workouts are unchanged.')
    } finally {
      setPlanReviewBusy(false)
    }
  }

  const rebuildTrainingSchedule = async () => {
    if (scheduleSaving) return
    const validationError = validateScheduleDraft(scheduleDraft)
    if (validationError) {
      setScheduleError(validationError)
      return
    }
    if (!scheduleHasChanges(myPlan?.plan_data, scheduleDraft)) {
      setScheduleEditing(false)
      setScheduleError('')
      return
    }

    setScheduleSaving(true)
    setScheduleError('')
    setScheduleNotice('')
    try {
      const request = buildScheduleRebuildRequest({
        planData: myPlan?.plan_data,
        goal: calendarModel?.goal,
        raceIds: protectedRaceIdsFromGoals(
          calendarModel?.goals?.length
            ? calendarModel.goals
            : calendarModel?.goal ? [calendarModel.goal] : [],
        ),
        draft: scheduleDraft,
        weekCount,
      })
      await previewAndApplyPlan(request.path, request.body, { timeout: 90000 })
      setRaceReconciliationError('')
      setPlanReviewError('')
      setScheduleNotice(`Calendar rebuilt for ${scheduleDraft.runDaysPerWeek} run days per week. Recorded workouts remain in your history and still inform the plan.`)
      setScheduleEditing(false)
      await loadAll()
    } catch (err) {
      if (isPlanCandidateReviewCancelled(err)) {
        setScheduleNotice('Your current plan was kept. No calendar changes were made.')
        return
      }
      console.error('[Plan] schedule rebuild failed:', err?.message || err)
      setScheduleError(err?.response?.data?.error || err?.message || 'Could not rebuild the training schedule. Your current calendar is unchanged.')
    } finally {
      setScheduleSaving(false)
    }
  }

  const decideAdaptation = async (decision) => {
    if (!adaptationProposal?.id) return
    setDecidingAdaptation(decision)
    setAdaptationError('')
    setAdaptationNotice('')
    try {
      await api.post(`/plans/adaptation/${adaptationProposal.id}/${decision}`, {
        proposal_revision: adaptationProposal.revision,
        proposal_plan_version: adaptationProposal.planVersion,
      })
      setAdaptationProposal(null)
      setAdaptationOpen(false)
      setAdaptationDecision(decision === 'accept' ? 'accepted' : 'kept')
      if (decision === 'accept') await loadAll({ includeAdaptation: false })
    } catch (err) {
      const errorData = err?.response?.data || {}
      if (['ADAPTATION_STALE', 'ADAPTATION_PROPOSAL_CHANGED', 'ADAPTATION_DECISION_TOKEN_REQUIRED'].includes(errorData.code)
        && errorData.refresh_required === true) {
        setAdaptationProposal(null)
        const refreshed = await loadAll()
        if (refreshed?.adaptationLoaded) {
          setAdaptationOpen(Boolean(refreshed.adaptationProposal))
          setAdaptationDecision('refreshed')
          setAdaptationNotice(refreshed.adaptationProposal
            ? 'Forge refreshed this adjustment because your calendar changed. Review the updated proposal before accepting it.'
            : 'Forge discarded the outdated adjustment and checked your latest calendar. No adjustment is pending now.')
        } else {
          setAdaptationError('Your calendar changed, but Forge could not load a fresh adjustment. Refresh the plan and try again.')
        }
      } else {
        setAdaptationError(errorData.error || 'Could not update this adjustment.')
      }
    } finally {
      setDecidingAdaptation(null)
    }
  }

  const formatEvidenceSource = (source) => {
    if (source === 'apple_health') return 'Apple Health'
    if (source === 'recent_run') return 'Recent run'
    if (source === 'checkin') return 'Check-in'
    if (source === 'completion') return 'Completion'
    if (source === 'injury') return 'Injury'
    return source || 'Signal'
  }

  const formatSession = (session = {}) => {
    const title = session.title || session.type || session.workout_type || session.kind || 'Session'
    const miles = Number(session.distance_miles ?? session.distance ?? session.miles)
    const duration = Number(session.duration_min ?? session.duration_minutes ?? session.minutes)
    const pieces = [title]
    if (Number.isFinite(miles) && miles > 0) pieces.push(`${Math.round(miles * 10) / 10} mi`)
    else if (Number.isFinite(duration) && duration > 0) pieces.push(`${Math.round(duration)} min`)
    if (session.intensity) pieces.push(session.intensity)
    return pieces.join(' · ')
  }

  const confirmOffScheduleStart = (sessionLabel) => {
    if (!selectedDay || selectedDay.dateISO === today) return true
    const scheduledDate = selectedDay.date?.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) || selectedDay.dateISO
    return window.confirm(`${sessionLabel} is scheduled for ${scheduledDate}. Start it now and keep it linked to that plan day?`)
  }

  const startRunSession = (runSession, { plannedRoute = null, surface = 'road' } = {}) => {
    if (!runSession || !confirmOffScheduleStart('This run')) return
    navigate('/warmup', { state: withActiveRunReturnTarget({
      planSessionId: runSession.id != null ? String(runSession.id) : null,
      currentWeek: Number.isFinite(selectedDay?.weekIndex) ? selectedDay.weekIndex + 1 : currentWeek,
      scheduledRun: runSession,
      startAfterWarmup: true,
      runType: runSession.prescription?.workout_type || runSession.type || 'run',
      runEnvironment: 'outdoor',
      surface,
      mapMyRun: true,
      plannedRoute,
      workoutTarget: {
        distanceMiles: runSession.distanceMiles || runSession.prescription?.distance_miles || null,
        durationMinutes: runSession.durationMinutes || runSession.prescription?.duration_min || null,
        prescriptionBasis: runSession.prescriptionBasis || runSession.prescription?.prescription_basis || null,
        pace: runSession.prescription?.pace_target || runSession.prescription?.pace || null,
        zone: runSession.prescription?.target_zone || null,
      },
    }, '/plan') })
  }

  const startLiftSession = (liftSession) => {
    if (!liftSession || !confirmOffScheduleStart('This lift')) return
    navigate('/log-lift', { state: {
      planSessionId: liftSession.id != null ? String(liftSession.id) : null,
      currentWeek: Number.isFinite(selectedDay?.weekIndex) ? selectedDay.weekIndex + 1 : currentWeek,
      scheduledLift: liftSession,
    } })
  }

  const startUnplannedRun = () => {
    navigate('/log-run?tab=manual&intent=rest-day')
  }

  const saveRace = async (payload, { affectsPlan } = {}) => {
    if (!activeRace?.id) return
    setRaceSaving(true)
    setRaceSaveError('')
    try {
      if (affectsPlan) {
        const { data: linkData } = await api.put('/plans/my/race-link', { race_id: activeRace.id })
        if (linkData?.plan_data) {
          setMyPlan((current) => current ? { ...current, plan_data: linkData.plan_data } : current)
        }
      }
      const { data } = await api.patch(`/races/${encodeURIComponent(activeRace.id)}`, payload)
      const updated = data?.race
      if (!updated) throw new Error('Race update did not return the saved race.')
      setRaces((current) => current.map((race) => String(race.id) === String(updated.id) ? updated : race))
      setRaceEditorOpen(false)
      setRaceSaveNotice(affectsPlan ? null : { message: 'Race details saved.' })
    } catch (err) {
      console.error('[Plan] race update failed:', err?.message || err)
      setRaceSaveError(err?.response?.data?.error || err?.message || 'Could not update this race.')
    } finally {
      setRaceSaving(false)
    }
  }

  if (loading) {
    return (
      <ProGate isPro={isPro} loading={proLoading} message="Adaptive training plans are a Pro feature">
        <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>Loading training plans...</div>
      </ProGate>
    )
  }

  const course = calendarModel?.goal?.course || null
  const planInputs = myPlan?.plan_data?.inputSummary || null
  const trainingEvidence = Array.isArray(myPlan?.plan_data?.trainingEvidence)
    ? myPlan.plan_data.trainingEvidence
    : []
  const courseProvenance = String(course?.provenance || '').toLowerCase()
  const courseState = course?.state || (
    ['official', 'licensed'].includes(courseProvenance)
      ? 'verified'
      : courseProvenance === 'curated'
        ? 'curated'
        : courseProvenance === 'user_gpx'
          ? 'user_gpx'
          : 'distance_only'
  )
  const courseStatus = (() => {
    if (courseState === 'user_gpx') return 'Course data: your GPX analysis is being used; precise coordinates are not stored.'
    if (courseState === 'stale') return 'Course data: course details are stale, so this calendar uses race date and distance only.'
    if (courseState === 'distance_only') return 'Course data: distance only; no course elevation, terrain, or altitude assumptions are used.'
    if (courseState === 'verified' || courseState === 'curated') {
      return courseState === 'verified' ? 'Verified course data' : 'Curated course data'
    }
    return 'Course data: distance only; no course elevation, terrain, or altitude assumptions are used.'
  })()
  const hasAdaptationChanges = adaptationProposal?.status === 'proposal'
    && (adaptationProposal?.changes || []).length > 0
    && adaptationProposal?.decisionStatus !== 'kept'
    && adaptationProposal?.decisionStatus !== 'accepted'

  const showAdaptationPanel = isActiveSchemaV2 && (
    adaptationLoading
    || Boolean(adaptationError)
    || hasAdaptationChanges
    || Boolean(adaptationProposal?.safetyException)
  )

  const adaptationPanel = showAdaptationPanel ? (
    <div className="rounded-lg min-w-0" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <button
        type="button"
        onClick={() => setAdaptationOpen((open) => !open)}
        aria-expanded={adaptationOpen}
        className="flex min-h-11 w-full items-start justify-between gap-3 p-4 text-left"
        style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}
      >
        <div className="min-w-0">
          <h2 className="text-base font-bold break-words" style={{ color: 'var(--text-primary)' }}>
            {adaptationProposal?.headline || 'Transparent adjustment'}
          </h2>
          <p className="text-sm mt-1 break-words" style={{ color: 'var(--text-muted)' }}>
            {adaptationLoading ? 'Checking the live calendar...' : adaptationProposal?.reason || 'No calendar adjustment is pending.'}
          </p>
          {adaptationProposal?.reason && <AiGuidanceNote />}
        </div>
        <span className="flex shrink-0 items-center gap-2">
          {adaptationProposal?.safetyException && <span className="text-xs font-bold rounded-full px-3 py-1" style={{ background: 'var(--danger-dim)', color: 'var(--danger)' }}>Safety</span>}
          {adaptationOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </span>
      </button>

      {adaptationOpen && <div className="space-y-3 p-4 pt-0">
      <p className="text-xs break-words" style={{ color: 'var(--text-muted)' }}>
        {courseState === 'verified' || courseState === 'curated' ? (
          <>
            {courseStatus}{course?.source || course?.url ? ' from ' : ''}
            {course?.url ? <a href={course.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{course.source || course.url}</a> : course?.source}.
          </>
        ) : courseStatus}
      </p>

      {adaptationError && (
        <p className="text-sm rounded-lg p-3 break-words" style={{ background: 'var(--danger-dim)', color: 'var(--danger)' }}>{adaptationError}</p>
      )}
      {adaptationNotice && (
        <p className="text-sm rounded-lg p-3 break-words" role="status" aria-live="polite" style={{ background: 'var(--accent-dim)', color: 'var(--text-primary)' }}>{adaptationNotice}</p>
      )}
      {adaptationDecision === 'accepted' && (
        <p className="text-sm rounded-lg p-3" style={{ background: 'rgba(22, 163, 74, 0.12)', color: 'var(--success)' }}>Accepted. Calendar updated.</p>
      )}
      {adaptationDecision === 'kept' && (
        <p className="text-sm rounded-lg p-3" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>Kept original calendar.</p>
      )}

      {!adaptationLoading && adaptationProposal && (
        <>
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)' }}>Evidence</p>
            {(adaptationProposal.evidence || []).length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No fresh driver was strong enough to change the calendar.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {(adaptationProposal.evidence || []).map((item, index) => (
                  <div key={`${item.signal || 'signal'}-${index}`} className="rounded-lg p-3 min-w-0" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{formatEvidenceSource(item.source)}</span>
                      <span className="text-[11px] rounded-full px-2 py-0.5" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>{item.objective ? 'objective' : 'subjective'}</span>
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{item.freshness}</span>
                    </div>
                    <p className="text-sm mt-1 break-words" style={{ color: 'var(--text-muted)' }}>{item.detail}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)' }}>Changed sessions</p>
            {(adaptationProposal.changes || []).length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No sessions change.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {(adaptationProposal.changes || []).map((change) => (
                  <div key={`${change.date}-${change.sessionId}`} className="rounded-lg p-3 min-w-0" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>{change.date}</p>
                    <p className="text-sm mt-1 break-words" style={{ color: 'var(--text-primary)' }}>{formatSession(change.before)} → {formatSession(change.after)}</p>
                    <p className="text-xs mt-1 break-words" style={{ color: 'var(--text-muted)' }}>{change.summary}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {hasAdaptationChanges && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button type="button" onClick={() => decideAdaptation('accept')} disabled={Boolean(decidingAdaptation)}
                className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
                {decidingAdaptation === 'accept' ? 'Accepting...' : 'Accept'}
              </button>
              <button type="button" onClick={() => decideAdaptation('keep')} disabled={Boolean(decidingAdaptation)}
                className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60"
                style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
                {decidingAdaptation === 'keep' ? 'Saving...' : 'Keep original'}
              </button>
            </div>
          )}
        </>
      )}
      </div>}
    </div>
  ) : null

  return (
    <ProGate isPro={isPro} loading={proLoading} message="Adaptive training plans are a Pro feature">
      <div className="space-y-4">
        {/* No active plan: setup lives in one Create / Manage flow. */}
        {!myPlan && (
          <div className="rounded-xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Build your training calendar</h2>
            <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>Choose a run-only or hybrid goal. Your race, workouts, and transparent adjustments will live in this calendar.</p>
            <div className="mt-4 flex flex-col sm:flex-row gap-2">
              <button type="button" onClick={() => navigate('/plan-catalog')} className="rounded-lg px-4 py-3 text-sm font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer' }}>
                Create / manage plan
              </button>
              <button type="button" onClick={() => navigate('/races')} className="rounded-lg px-4 py-3 text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', cursor: 'pointer' }}>
                Manage races
              </button>
            </div>
          </div>
        )}

        {myPlan && planReviewRequired && (
          <div role="status" className="rounded-xl p-4" style={{ background: 'var(--accent-dim)', border: '1px solid var(--accent)', color: 'var(--text-primary)' }}>
            <h2 className="text-base font-bold">Your plan needs a frequency review</h2>
            <p className="text-sm mt-1">
              Your saved preference is now {planReviewRequired.requestedRunDaysPerWeek} run day{Number(planReviewRequired.requestedRunDaysPerWeek) === 1 ? '' : 's'} per week.
              The active calendar has not been rewritten; review the eligible weekdays and rebuild it explicitly.
            </p>
            <button
              type="button"
              onClick={() => navigate('/plan-catalog', { state: activeRace?.id ? { raceId: activeRace.id } : null })}
              className="mt-3 text-sm font-bold"
              style={{ background: 'transparent', border: 0, color: 'var(--accent)', padding: 0, cursor: 'pointer' }}
            >
              Review and rebuild calendar →
            </button>
          </div>
        )}

        {myPlan && currentWeekConstraint?.status === 'partial_current_week' && (
          <div role="status" className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
            <h2 className="text-base font-bold">Your first week is partial</h2>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>{currentWeekConstraint.explanation}</p>
          </div>
        )}

        {myPlan && racePlanReviews.length > 0 && (
          <section role="status" aria-labelledby="race-plan-review-title" className="min-w-0 rounded-xl p-4" style={{ background: 'var(--accent-dim)', border: '1px solid var(--accent)' }}>
            <p className="text-[10px] font-black uppercase" style={{ color: 'var(--accent)', margin: 0 }}>Plan needs review</p>
            <h2 id="race-plan-review-title" className="mt-1 break-words text-base font-black" style={{ color: 'var(--text-primary)' }}>
              {racePlanReviews.length === 1
                ? `${racePlanReviews[0].race.race_name} changed`
                : 'Your protected race targets changed'}
            </h2>
            <p className="mt-1 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
              The race details are saved, but the current workouts still use the previous target. Rebuild explicitly to preserve every protected race and recalculate pace, progression, peak, and taper.
            </p>
            {planReviewError && <p role="alert" className="mt-3 rounded-lg p-3 text-sm" style={{ background: 'var(--danger-dim)', color: 'var(--danger)' }}>{planReviewError}</p>}
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button type="button" onClick={rebuildRacePlan} disabled={planReviewBusy} className="min-h-11 rounded-lg px-4 py-3 text-sm font-black disabled:opacity-60" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
                {planReviewBusy ? 'Rebuilding…' : 'Rebuild for updated races'}
              </button>
              <button type="button" onClick={() => navigate('/races')} disabled={planReviewBusy} className="min-h-11 rounded-lg px-4 py-3 text-sm font-bold disabled:opacity-60" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
                Review races
              </button>
            </div>
          </section>
        )}

        {/* Active plan: the Forged Training Calendar is primary */}
        {myPlan && calendarModel && (
          <section
            ref={currentPlanCalendarRef}
            id="current-plan-calendar"
            tabIndex={-1}
            aria-label={`Current plan calendar for ${myPlan.name}`}
            className="space-y-4"
            style={{ scrollMarginTop: 'calc(env(safe-area-inset-top, 0px) + 76px)' }}
          >
            {selectedDay ? (
            <ForgedDayView
              day={selectedDay}
              planContext={{
                goal: calendarModel.goal,
                mode: calendarModel.mode,
                modeLabel: calendarModel.modeLabel,
                phase: selectedPhase,
                week: selectedWeek,
                feasibility: calendarModel.feasibility,
                inputSummary: calendarModel.inputSummary || planInputs,
                trainingEvidence: calendarModel.trainingEvidence?.length ? calendarModel.trainingEvidence : trainingEvidence,
              }}
              completedSet={completedSet}
              onToggleComplete={toggleSession}
              onRemoveSession={removePlanSession}
              onStartRun={startRunSession}
              onStartLift={startLiftSession}
              onStartUnplannedRun={startUnplannedRun}
              onOpenRecordedRun={(activity) => navigate(`/history?runId=${encodeURIComponent(activity.id)}`)}
              onBack={() => setSelectedDayISO(null)}
              updating={updating}
              removingSessionId={removingSessionId}
              removalError={sessionRemovalError}
              removalNotice={sessionRemovalNotice}
              allowSessionRemoval={selectedDay.dateISO >= today}
              isScheduledToday={selectedDay.dateISO === today}
              routePlanner={routePlannerStatus.available && routePlannerWorkout?.distanceMiles > 0 ? (
                <Suspense fallback={<p style={{ marginTop: 10, fontSize: 12, color: 'var(--ink-soft, #5A554B)' }}>Loading route planner...</p>}>
                  <RoutePlanner
                    workout={routePlannerWorkout}
                    onStart={(plannedRoute, surface) => startRunSession(selectedRunSession, { plannedRoute, surface })}
                    title="Map this run"
                    startLabel="Warm up and start this route"
                    variant="paper"
                  />
                </Suspense>
              ) : null}
            />
          ) : (
            <>
              <ForgedCalendar
                model={calendarModel}
                currentWeekIndex={weekIndex}
                weekCount={weekCount}
                completedSet={completedSet}
                todayISO={today}
                recordedRunsByDate={recordedRunsByDate}
                onPrevWeek={() => goToWeek(Math.max(1, currentWeek - 1))}
                onNextWeek={() => goToWeek(Math.min(weekCount || currentWeek, currentWeek + 1))}
                onOpenDay={(day) => setSelectedDayISO(day.dateISO)}
                onEditGoal={activeRace ? () => {
                  if ((calendarModel.goals || []).length > 1) {
                    navigate('/races')
                    return
                  }
                  setRaceSaveError('')
                  setRaceSaveNotice(null)
                  setRaceEditorOpen(true)
                } : null}
                canPrev={currentWeek > 1 && !updating}
                canNext={currentWeek < (weekCount || currentWeek) && !updating}
              />

              <RacePlanReconciliationCard
                candidate={racePlanReconciliation}
                busy={reconcilingRaces}
                error={raceReconciliationError}
                onAdd={addRaceToPlan}
                onReview={() => navigate('/races')}
              />

              {raceReconciliationNotice && (
                <p role="status" aria-live="polite" className="rounded-lg p-3 text-sm" style={{ background: 'rgba(22,163,74,0.12)', color: 'var(--success)', border: '1px solid var(--border-subtle)' }}>
                  {raceReconciliationNotice}
                </p>
              )}

              <TravelTrainingPrompt
                execution={travelExecution}
                checkinData={travelCheckin}
                adaptationProposal={adaptationProposal}
                readiness={travelReadiness}
                activeInjury={travelInjurySafetyAvailable ? travelActiveInjury : { unknown: true }}
                runRecordedToday={hasRunRecordedToday}
                dateISO={today}
              />

              {raceSaveNotice && (
                <div role="status" className="rounded-lg p-3" style={{ marginTop: 12, background: 'rgba(22,163,74,0.12)', border: '1px solid var(--border-subtle)' }}>
                  <p className="text-sm" style={{ color: 'var(--text-primary)', margin: 0 }}>{raceSaveNotice.message}</p>
                </div>
              )}

              {adaptationPanel}

              {/* Secondary plan controls in a compact Manage plan disclosure */}
              <div className="rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                <button type="button" onClick={() => setManageOpen((v) => !v)}
                  className="w-full flex items-center justify-between p-4"
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}
                  aria-expanded={manageOpen}>
                  <span className="text-sm font-bold">Manage plan</span>
                  {manageOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </button>
                {manageOpen && (
                  <div className="p-4 pt-0 space-y-3">
                    <button
                      type="button"
                      onClick={openCurrentPlan}
                      aria-labelledby="current-plan-action-name"
                      aria-describedby="current-plan-action-details"
                      className="block w-full rounded-lg p-3 text-left"
                      style={{ background: 'var(--bg-input)', color: 'inherit', border: 'none', cursor: 'pointer' }}
                    >
                      <span id="current-plan-action-name" className="block text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{myPlan.name}</span>
                      <span id="current-plan-action-details" className="mt-1 block text-xs" style={{ color: 'var(--text-muted)' }}>{myPlan.type} · Week {currentWeek} of {myPlan.weeks}</span>
                    </button>
                    <div className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-bold" style={{ color: 'var(--text-primary)', margin: 0 }}>Training rhythm</p>
                          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                            {scheduleDraftFromPlan(myPlan.plan_data).runDaysPerWeek} run days · {scheduleDraftFromPlan(myPlan.plan_data).trainingDays.join(', ')}
                          </p>
                        </div>
                        {!scheduleEditing && (
                          <button type="button" onClick={() => {
                            setScheduleDraft(scheduleDraftFromPlan(myPlan.plan_data))
                            setScheduleError('')
                            setScheduleEditing(true)
                          }} className="shrink-0 text-xs font-black" style={{ background: 'transparent', border: 0, color: 'var(--accent)', padding: 0 }}>
                            Edit days
                          </button>
                        )}
                      </div>

                      {scheduleNotice && !scheduleEditing && (
                        <p role="status" className="mt-3 rounded-lg p-3 text-xs" style={{ background: 'rgba(22,163,74,0.12)', color: 'var(--success)' }}>{scheduleNotice}</p>
                      )}

                      {scheduleEditing && (
                        <div className="mt-4 space-y-4">
                          <div>
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-xs font-bold" style={{ color: 'var(--text-primary)', margin: 0 }}>Eligible training weekdays</p>
                              <span className="text-[11px] font-bold" style={{ color: 'var(--text-muted)' }}>{scheduleDraft.trainingDays.length} selected</span>
                            </div>
                            <div className="mt-2 grid grid-cols-7 gap-1.5">
                              {TRAINING_DAY_OPTIONS.map((day) => {
                                const active = scheduleDraft.trainingDays.includes(day)
                                return (
                                  <button key={day} type="button" aria-pressed={active} onClick={() => {
                                    setScheduleDraft((current) => toggleTrainingDay(current, day))
                                    setScheduleError('')
                                  }} className="min-h-11 min-w-0 rounded-lg text-[10px] font-black" style={{ border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`, background: active ? 'var(--accent-dim)' : 'var(--bg-card)', color: active ? 'var(--accent)' : 'var(--text-muted)' }}>
                                    {day}
                                  </button>
                                )
                              })}
                            </div>
                          </div>

                          <label className="grid gap-2">
                            <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>Runs each week</span>
                            <select value={scheduleDraft.runDaysPerWeek} onChange={(event) => {
                              setScheduleDraft((current) => ({ ...current, runDaysPerWeek: Number(event.target.value) }))
                              setScheduleError('')
                            }} className="min-h-11 rounded-lg px-3 text-sm" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
                              {Array.from({ length: Math.max(1, Math.min(6, scheduleDraft.trainingDays.length)) }, (_, index) => index + 1).map((count) => (
                                <option key={count} value={count}>{count} run day{count === 1 ? '' : 's'}</option>
                              ))}
                            </select>
                          </label>

                          <p className="text-xs leading-5" style={{ color: 'var(--text-muted)', margin: 0 }}>
                            {scheduleFrequencyGuidance(scheduleDraft.runDaysPerWeek)}
                          </p>
                          <p className="text-xs leading-5" style={{ color: 'var(--text-muted)', margin: 0 }}>
                            Rebuilding changes today and future workouts. Recorded runs, lifts, and health data remain intact and set the safe mileage progression.
                          </p>
                          {scheduleError && <p role="alert" className="rounded-lg p-3 text-xs" style={{ background: 'var(--danger-dim)', color: 'var(--danger)' }}>{scheduleError}</p>}
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <button type="button" onClick={rebuildTrainingSchedule} disabled={scheduleSaving || !scheduleHasChanges(myPlan.plan_data, scheduleDraft)} className="min-h-11 rounded-lg px-3 text-xs font-black disabled:opacity-50" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
                              {scheduleSaving ? 'Rebuilding…' : 'Rebuild remaining calendar'}
                            </button>
                            <button type="button" onClick={() => {
                              setScheduleDraft(scheduleDraftFromPlan(myPlan.plan_data))
                              setScheduleError('')
                              setScheduleEditing(false)
                            }} disabled={scheduleSaving} className="min-h-11 rounded-lg px-3 text-xs font-bold disabled:opacity-50" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <button type="button" onClick={() => navigate('/plan-catalog')} className="text-xs font-bold" style={{ background: 'transparent', border: 'none', color: 'var(--accent)', padding: 0, cursor: 'pointer' }}>
                        Create / manage plan →
                      </button>
                      <button type="button" onClick={() => navigate('/races')} className="text-xs font-bold" style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', padding: 0, cursor: 'pointer' }}>
                        Races →
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
            )}
          </section>
        )}

        {raceEditorOpen && activeRace && (
          <RaceEditSheet
            key={`${activeRace.id}-${activeRace.updated_at || ''}`}
            race={activeRace}
            saving={raceSaving}
            serverError={raceSaveError}
            onClose={() => {
              if (raceSaving) return
              setRaceSaveError('')
              setRaceEditorOpen(false)
            }}
            onSave={saveRace}
          />
        )}
      </div>
    </ProGate>
  )
}
