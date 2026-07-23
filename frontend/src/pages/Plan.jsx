import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronUp } from 'lucide-react'
import api from '../lib/api'
import { useProContext } from '../context/ProContext'
import ProGate from '../components/ProGate'
import AiGuidanceNote from '../components/AiGuidanceNote'
import ForgedCalendar from '../components/calendar/ForgedCalendar'
import ForgedDayView from '../components/calendar/ForgedDayView'
import RaceEditSheet from '../components/calendar/RaceEditSheet'
import {
  buildCalendarModel, calendarDateRange, dayWithRecordedRuns, goalWithRace, indexRecordedRuns, racePlanReview, todayISO,
} from '../lib/planCalendar'

const RoutePlanner = lazy(() => import('../components/RoutePlanner'))

export default function Plan() {
  const navigate = useNavigate()
  const { isPro, loading: proLoading } = useProContext()
  const [myPlan, setMyPlan] = useState(null)
  const [myUserPlan, setMyUserPlan] = useState(null)
  const [adaptationProposal, setAdaptationProposal] = useState(null)
  const [adaptationLoading, setAdaptationLoading] = useState(false)
  const [adaptationError, setAdaptationError] = useState('')
  const [adaptationDecision, setAdaptationDecision] = useState(null)
  const [decidingAdaptation, setDecidingAdaptation] = useState(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [selectedDayISO, setSelectedDayISO] = useState(null)
  const [manageOpen, setManageOpen] = useState(false)
  const [adaptationOpen, setAdaptationOpen] = useState(false)
  const [routePlannerStatus, setRoutePlannerStatus] = useState({ available: false, requiresPro: false })
  const [races, setRaces] = useState([])
  const [runs, setRuns] = useState([])
  const [raceEditorOpen, setRaceEditorOpen] = useState(false)
  const [raceSaving, setRaceSaving] = useState(false)
  const [raceSaveError, setRaceSaveError] = useState('')
  const [raceSaveNotice, setRaceSaveNotice] = useState(null)

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
      const [racesRes, runsRes] = await Promise.all([
        api.get('/races').catch((err) => {
          console.error('[Plan] race list load failed:', err?.message || err)
          return null
        }),
        api.get('/runs', { params: runDateRange ? { ...runDateRange, limit: 500 } : { limit: 50 } }).catch((err) => {
          console.error('[Plan] recorded runs load failed:', err?.message || err)
          return null
        }),
      ])
      if (racesRes) setRaces(Array.isArray(racesRes.data?.races) ? racesRes.data.races : [])
      if (runsRes) setRuns(Array.isArray(runsRes.data) ? runsRes.data : Array.isArray(runsRes.data?.runs) ? runsRes.data.runs : [])
      if (includeAdaptation) setAdaptationProposal(null)
      const isSchemaV2 = Number(nextPlan?.plan_data?.schemaVersion || 0) === 2
      if (isSchemaV2 && includeAdaptation) {
        setAdaptationLoading(true)
        try {
          const adaptationRes = await api.get('/plans/adaptation/current', { params: { date: todayISO() } })
          setAdaptationProposal(adaptationRes.data?.proposal || null)
        } catch (err) {
          setAdaptationProposal(null)
          setAdaptationError(err?.response?.data?.error || 'Transparent adjustment is not available right now.')
        } finally {
          setAdaptationLoading(false)
        }
      } else {
        setAdaptationLoading(false)
      }
    } catch (err) {
      console.error('[Plan] failed to load active plan:', err?.message || err)
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

  const currentWeek = Math.max(1, Number(myUserPlan?.current_week || 1))
  const weekIndex = currentWeek - 1
  const today = todayISO()
  const completedSet = useMemo(
    () => new Set((myUserPlan?.progress?.completedSessionIds || []).map(String)),
    [myUserPlan],
  )

  const model = useMemo(
    () => (myPlan ? buildCalendarModel(myPlan, myUserPlan) : null),
    [myPlan, myUserPlan],
  )
  const recordedRunsByDate = useMemo(() => indexRecordedRuns(runs), [runs])
  const activeRace = useMemo(() => {
    if (!model?.goal) return null
    if (model.goal.raceId) {
      const exact = races.find((race) => String(race.id) === String(model.goal.raceId))
      if (exact) return exact
    }
    const normalizedGoalName = String(model.goal.name || '').trim().toLowerCase()
    return races.find((race) => (
      race.race_date === model.goal.dateISO
      && String(race.race_name || '').trim().toLowerCase() === normalizedGoalName
      && (!model.goal.distanceMiles || Math.abs(Number(race.distance_miles || 0) - Number(model.goal.distanceMiles)) < 0.01)
    )) || null
  }, [model, races])
  const calendarModel = useMemo(() => (
    model && activeRace ? { ...model, goal: goalWithRace(model.goal, activeRace) } : model
  ), [model, activeRace])
  const planReview = useMemo(
    () => racePlanReview(model?.goal, activeRace),
    [model, activeRace],
  )
  const isActiveSchemaV2 = Number(myPlan?.plan_data?.schemaVersion || 0) === 2
  const weekCount = Number(myPlan?.weeks || calendarModel?.weekCount || 0)

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

  const toggleSession = async (sessionId) => {
    if (!sessionId) return
    const isCompleted = completedSet.has(String(sessionId))
    setUpdating(true)
    try {
      await api.put('/plans/my/progress', isCompleted
        ? { unset_session_id: sessionId, current_week: currentWeek }
        : { completed_session_id: sessionId, current_week: currentWeek })
      await loadAll()
    } finally {
      setUpdating(false)
    }
  }

  const goToWeek = async (nextWeek) => {
    setUpdating(true)
    try {
      await api.put('/plans/my/progress', { current_week: nextWeek })
      await loadAll()
    } finally {
      setUpdating(false)
    }
  }

  const decideAdaptation = async (decision) => {
    if (!adaptationProposal?.id) return
    setDecidingAdaptation(decision)
    setAdaptationError('')
    try {
      await api.post(`/plans/adaptation/${adaptationProposal.id}/${decision}`)
      setAdaptationProposal(null)
      setAdaptationOpen(false)
      setAdaptationDecision(decision === 'accept' ? 'accepted' : 'kept')
      if (decision === 'accept') await loadAll({ includeAdaptation: false })
    } catch (err) {
      setAdaptationError(err?.response?.data?.error || 'Could not update this adjustment.')
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
    navigate('/warmup', { state: {
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
    } })
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
        // Persist the exact pre-edit race target in the active plan before the
        // race changes. Existing linked plans no-op once that snapshot exists.
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

        {/* Active plan: the Forged Training Calendar is primary */}
        {myPlan && calendarModel && (
          <>
            {planReview.required && activeRace && (
              <div
                role="status"
                aria-label="Plan needs review"
                className="rounded-lg p-4 min-w-0"
                style={{ background: 'var(--accent-dim)', border: '1px solid var(--accent)', overflowWrap: 'anywhere' }}
              >
                <p className="text-xs font-black uppercase" style={{ color: 'var(--accent)', margin: 0 }}>Plan needs review</p>
                <p className="text-sm font-bold" style={{ color: 'var(--text-primary)', margin: '5px 0 0' }}>
                  Your race target changed. Your current workouts have not changed.
                </p>
                <p className="text-xs" style={{ color: 'var(--text-muted)', margin: '5px 0 0' }}>
                  Review how goal pace, quality-session targets, progression, peak, and taper may change. You can keep this plan until you explicitly rebuild it.
                </p>
                <button
                  type="button"
                  onClick={() => navigate('/plan-catalog', { state: { raceId: activeRace.id, reviewUpdatedPlan: true } })}
                  className="rounded-lg"
                  style={{ width: '100%', minWidth: 0, minHeight: 44, marginTop: 12, padding: '10px 14px', border: 0, background: 'var(--accent)', color: 'var(--on-accent)', fontSize: 14, fontWeight: 900 }}
                >
                  Review updated plan
                </button>
              </div>
            )}

            {selectedDay ? (
            <ForgedDayView
              day={selectedDay}
              planContext={{ goal: calendarModel.goal, mode: calendarModel.mode, modeLabel: calendarModel.modeLabel, phase: selectedPhase, inputSummary: planInputs, trainingEvidence }}
              completedSet={completedSet}
              onToggleComplete={toggleSession}
              onStartRun={startRunSession}
              onStartLift={startLiftSession}
              onStartUnplannedRun={startUnplannedRun}
              onOpenRecordedRun={(activity) => navigate(`/history?runId=${encodeURIComponent(activity.id)}`)}
              onBack={() => setSelectedDayISO(null)}
              updating={updating}
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
                onOpenToday={(day) => setSelectedDayISO(day.dateISO)}
                onEditGoal={activeRace ? () => {
                  setRaceSaveError('')
                  setRaceSaveNotice(null)
                  setRaceEditorOpen(true)
                } : null}
                canPrev={currentWeek > 1 && !updating}
                canNext={currentWeek < (weekCount || currentWeek) && !updating}
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
                    <div className="rounded-lg p-3" style={{ background: 'var(--bg-input)' }}>
                      <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{myPlan.name}</p>
                      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{myPlan.type} · Week {currentWeek} of {myPlan.weeks}</p>
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
          </>
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
