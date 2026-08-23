import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { buildCalendarModel } from '../src/lib/planCalendar.js'
import { buildWeeklyRunBrief } from '../src/lib/weeklyRunBrief.js'
import {
  hasExecutableSession,
  normalizeExecution,
  scheduledLiftFromExecution,
  scheduledRunFromExecution,
  validateSurfaceManifest,
} from '../src/lib/dailyExecutionCore.js'
import { workoutStartDecision } from '../src/lib/todayPlanAccess.js'
import {
  capabilityLabel,
  executabilityLabel,
  phaseLabel,
  reasonCodeLabel,
  safetyActionLabel,
  safetyScopeList,
  sessionRoleLabel,
} from '../src/lib/goalBackwardPresentation.js'
import {
  buildAcceptedCanonicalWorkout,
  buildFitWorkoutRepresentation,
} from '../src/services/fit/encodeWorkoutFit.js'
import { goalBackwardV24PlanFixture } from './e2e/support/mockApi.mjs'

const require = createRequire(import.meta.url)
const plansRoute = require('../../backend/src/routes/plans.js')

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}
const checkAsync = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

const hash = (character) => character.repeat(64)
const provenance = Object.freeze({
  evidence_ids: ['evidence-threshold-1'],
  athlete_state_field: 'threshold_pace_s_per_km',
  policy_id: 'goal_backward_target_hierarchy_v1',
  policy_version: '1.0.0',
  confidence: 'HIGH',
  derived_at: '2026-08-14T12:00:00.000Z',
  decision_id: 'decision-surface-1',
  canonical_unit: 's_per_km',
})
const canonicalSession = Object.freeze({
  canonical_workout_schema_version: 1,
  session_id: 'session-threshold-1',
  session_revision: 4,
  plan_id: 'plan-canonical-1',
  plan_revision: 7,
  decision_id: 'decision-surface-1',
  goal_ids: ['goal-half-1'],
  phase: 'EVENT_SPECIFIC_DEVELOPMENT',
  role: 'PRIMARY_KEY',
  workout_family: 'threshold_run',
  title: 'Controlled threshold intervals',
  purpose_reason_codes: ['KEY_STIMULUS_REQUIRED', 'LIMITER_THRESHOLD'],
  scheduled_local_date: '2026-08-17',
  timezone: 'America/New_York',
  stress_vector: { aerobic: 7, mechanical: 5 },
  steps: [{
    step_id: 'step-threshold-1',
    type: 'interval',
    order: 1,
    target: { duration_s: 1200, pace_range_s_per_km: { minimum: 285, maximum: 295 } },
    provenance: [provenance],
  }],
  derived_totals: { distance_m: 0, duration_s: 1200 },
  target_provenance: [provenance],
  success_criteria: ['Complete the prescribed work under control.'],
  adjustment_criteria: ['Reduce one interval if control is lost.'],
  stop_criteria: ['Stop for sharp pain or altered mechanics.'],
  safety_scope: ['RUN', 'IMPACT'],
  executability: 'EXECUTABLE',
  capability: {
    classification: 'FULLY_STRUCTURED',
    manual_step_ids: [],
    unsupported_step_ids: [],
  },
  content_hash: hash('c'),
})

const canonicalPlanData = {
  schemaVersion: 2,
  canonical_workout_schema_version: 1,
  plan_id: 'plan-canonical-1',
  plan_revision: 7,
  decision_id: 'decision-surface-1',
  decision_hash: hash('d'),
  selected_candidate_id: 'candidate-surface-1',
  selected_candidate_hash: hash('a'),
  canonical_session_set_hash: hash('b'),
  planMode: 'run_only',
  overall_feasibility: 'supported',
  reasons: ['GOAL_EXPOSURES_SUPPORTED'],
  weeks: [{
    week: 1,
    startDate: '2026-08-17',
    phase: 'EVENT_SPECIFIC_DEVELOPMENT',
    purpose: 'Develop the accepted threshold limiter while preserving recovery.',
    days: [{ date: '2026-08-17', day: 'Mon', sessions: [canonicalSession] }],
  }],
}

const surfaceManifest = Object.freeze({
  schema_version: 'goal_backward_surface_manifest_v1',
  surface_revision: 3,
  feature_mode: 'on',
  v24_surface_enabled: true,
  status: 'accepted',
  identity: {
    decision_id: 'decision-surface-1',
    decision_hash: hash('d'),
    candidate_id: 'candidate-surface-1',
    candidate_revision: 2,
    candidate_hash: hash('a'),
    plan_id: 'plan-canonical-1',
    plan_revision: 7,
    canonical_session_set_hash: hash('b'),
    athlete_state_revision: 9,
    safety_state_hash: `sha256:${hash('e')}`,
    goal_revisions: { 'goal-half-1': 5 },
  },
  purpose: 'Develop the accepted threshold limiter while preserving recovery.',
  feasibility: {
    status: 'supported',
    reason_codes: ['GOAL_EXPOSURES_SUPPORTED'],
  },
  safety: {
    action: 'MONITOR',
    scope: ['RUN', 'IMPACT'],
    reason_codes: ['MONITOR_RECOVERY'],
  },
  weeks: [{
    week: 1,
    start_date: '2026-08-17',
    phase: 'EVENT_SPECIFIC_DEVELOPMENT',
    purpose: 'Develop the accepted threshold limiter while preserving recovery.',
  }],
  sessions: [canonicalSession],
})

const plan = { id: 'plan-canonical-1', weeks: 1, plan_data: canonicalPlanData }
const userPlan = { id: 'assignment-1', plan_version: 7, progress: { completedSessionIds: [] } }

check('backend emits one accepted manifest beside an applicable plan and no manifest when flag-off', () => {
  const built = plansRoute._test.buildCanonicalSurfaceManifest({
    featureMode: 'on',
    surfaceRevision: 3,
    candidateRevision: 2,
    athleteStateRevision: 9,
    safetyStateHash: `sha256:${hash('e')}`,
    goalRevisions: { 'goal-half-1': 5 },
    decision: {
      decision_id: 'decision-surface-1',
      decision_hash: hash('d'),
      safety_state: { action: 'MONITOR', scope: ['RUN', 'IMPACT'], reason_codes: ['MONITOR_RECOVERY'] },
    },
    selectedCandidate: { candidate_skeleton_id: 'candidate-surface-1' },
    canonicalSessionSet: {
      plan_id: 'plan-canonical-1',
      plan_revision: 7,
      decision_id: 'decision-surface-1',
      decision_hash: hash('d'),
      candidate_id: 'candidate-surface-1',
      candidate_hash: hash('a'),
      content_hash: hash('b'),
      sessions: [canonicalSession],
    },
    plan: canonicalPlanData,
  })
  assert.deepEqual(built, surfaceManifest)
  assert.equal(plansRoute._test.buildCanonicalSurfaceManifest({ featureMode: 'off' }), null)
})

await checkAsync('backend serves the manifest only when the applied owner/assignment and canonical artifact chain match', async () => {
  const candidate = {
    id: 'candidate-db-1',
    decision_id: surfaceManifest.identity.decision_id,
    candidate_revision: surfaceManifest.identity.candidate_revision,
    athlete_state_revision: surfaceManifest.identity.athlete_state_revision,
    safety_state_hash: surfaceManifest.identity.safety_state_hash,
    goal_revisions_json: surfaceManifest.identity.goal_revisions,
    surface_revision: surfaceManifest.surface_revision,
    feature_mode: surfaceManifest.feature_mode,
    selected_candidate_hash: surfaceManifest.identity.candidate_hash,
  }
  const canonicalArtifact = {
    plan_id: surfaceManifest.identity.plan_id,
    plan_revision: surfaceManifest.identity.plan_revision,
    decision_id: surfaceManifest.identity.decision_id,
    decision_hash: surfaceManifest.identity.decision_hash,
    candidate_id: surfaceManifest.identity.candidate_id,
    candidate_hash: surfaceManifest.identity.candidate_hash,
    content_hash: surfaceManifest.identity.canonical_session_set_hash,
    sessions: surfaceManifest.sessions,
  }
  let calls = 0
  const query = async () => {
    calls += 1
    return calls === 1
      ? candidate
      : { payload_json: surfaceManifest, canonical_payload_json: canonicalArtifact }
  }
  const served = await plansRoute._test.canonicalSurfaceManifestForActive(
    'owner-1',
    { user_plan_id: 'assignment-1', plan_version: 7, plan_data: canonicalPlanData },
    query,
  )
  assert.deepEqual(served, surfaceManifest)

  const absent = await plansRoute._test.canonicalSurfaceManifestForActive(
    'owner-1',
    { user_plan_id: 'assignment-legacy', plan_version: 1, plan_data: { weeks: [] } },
    async () => null,
  )
  assert.equal(absent, null)
})

check('accepted manifest validation binds plan, assignment, revisions, hashes, safety, and all canonical sessions', () => {
  const result = validateSurfaceManifest({ plan, userPlan, manifest: surfaceManifest })
  assert.equal(result.status, 'accepted')
  assert.deepEqual(result.identity, surfaceManifest.identity)
  assert.deepEqual(result.sessionsById.get(canonicalSession.session_id), canonicalSession)
})

check('Watch/FIT adapters retain the accepted identity, exact canonical steps, provenance, safety, and export revision', () => {
  const accepted = buildAcceptedCanonicalWorkout({
    surfaceManifest,
    sessionId: canonicalSession.session_id,
    exportRevision: 2,
  })
  assert.deepEqual(accepted.identity, {
    session_id: canonicalSession.session_id,
    session_revision: canonicalSession.session_revision,
    plan_id: canonicalSession.plan_id,
    plan_revision: canonicalSession.plan_revision,
    surface_revision: surfaceManifest.surface_revision,
    export_revision: 2,
    content_hash: canonicalSession.content_hash,
  })
  assert.equal(accepted.role, canonicalSession.role)
  assert.deepEqual(accepted.steps, canonicalSession.steps)
  assert.deepEqual(accepted.target_provenance, canonicalSession.target_provenance)
  assert.deepEqual(accepted.safety, {
    action: surfaceManifest.safety.action,
    scope: canonicalSession.safety_scope,
    reason_codes: surfaceManifest.safety.reason_codes,
    executability: canonicalSession.executability,
  })

  const fit = buildFitWorkoutRepresentation({
    surfaceManifest,
    sessionId: canonicalSession.session_id,
    exportRevision: 2,
  })
  assert.deepEqual(fit.identity, accepted.identity)
  assert.equal(fit.role, canonicalSession.role)
  assert.deepEqual(fit.canonical_steps, canonicalSession.steps)
  assert.deepEqual(fit.target_provenance, canonicalSession.target_provenance)
  assert.deepEqual(fit.safety, accepted.safety)
  assert.equal(fit.capability.classification, 'FULLY_STRUCTURED')
})

check('weekly brief and calendar consume the exact accepted session instead of deriving a new prescription', () => {
  const model = buildCalendarModel(plan, userPlan, { surfaceManifest })
  assert.equal(model.surface.status, 'accepted')
  const displayed = model.getWeek(0).days[0].sessions[0]
  assert.equal(displayed.id, canonicalSession.session_id)
  assert.equal(displayed.sessionRevision, canonicalSession.session_revision)
  assert.equal(displayed.contentHash, canonicalSession.content_hash)
  assert.equal(displayed.role, canonicalSession.role)
  assert.deepEqual(displayed.steps, canonicalSession.steps)
  assert.deepEqual(displayed.targetProvenance, canonicalSession.target_provenance)
  assert.deepEqual(displayed.safetyScope, canonicalSession.safety_scope)
  assert.deepEqual(displayed.capability, canonicalSession.capability)
  assert.deepEqual(displayed.purposeReasonCodes, canonicalSession.purpose_reason_codes)

  const brief = buildWeeklyRunBrief({ week: model.getWeek(0), todayISO: '2026-08-17' })
  assert.equal(brief.surface.status, 'accepted')
  assert.equal(brief.purpose, surfaceManifest.purpose)
  assert.equal(brief.feasibility.status, surfaceManifest.feasibility.status)
  assert.deepEqual(brief.feasibility.reasonCodes, surfaceManifest.feasibility.reason_codes)
  assert.deepEqual(brief.days[0].canonical, {
    sessionId: canonicalSession.session_id,
    sessionRevision: canonicalSession.session_revision,
    planRevision: canonicalSession.plan_revision,
    contentHash: canonicalSession.content_hash,
    role: canonicalSession.role,
    steps: canonicalSession.steps,
    targetProvenance: canonicalSession.target_provenance,
    purposeReasonCodes: canonicalSession.purpose_reason_codes,
    adjustmentCriteria: canonicalSession.adjustment_criteria,
    stopCriteria: canonicalSession.stop_criteria,
    safetyScope: canonicalSession.safety_scope,
    executability: canonicalSession.executability,
    capability: canonicalSession.capability,
  })
  assert.equal(brief.days[0].footwear, null, 'v2.4 surface does not create a frontend shoe prescription')
})

check('daily detail normalization retains exact canonical truth and respects executability', () => {
  const normalized = normalizeExecution({
    plan,
    user_plan: userPlan,
    surface_manifest: surfaceManifest,
    execution: {
      hasPlan: true,
      hasDay: true,
      isRest: false,
      date: canonicalSession.scheduled_local_date,
      sessions: [canonicalSession],
      run: canonicalSession,
      lift: null,
    },
  })
  assert.equal(normalized.surface.status, 'accepted')
  assert.deepEqual(normalized.sessions[0].steps, canonicalSession.steps)
  assert.deepEqual(normalized.sessions[0].target_provenance, canonicalSession.target_provenance)
  assert.deepEqual(normalized.sessions[0].capability, canonicalSession.capability)
  assert.equal(hasExecutableSession(normalized), true)
})

check('scoped safety blocks a restricted run while retaining an accepted upper-body session', () => {
  const restrictedRun = { ...canonicalSession, executability: 'RESTRICTED', content_hash: hash('f') }
  const upperBody = {
    ...canonicalSession,
    session_id: 'session-upper-1',
    role: 'SUPPORTING',
    workout_family: 'strength_upper',
    title: 'Upper-body strength',
    steps: [{ ...canonicalSession.steps[0], step_id: 'upper-step-1', type: 'strength_exercise' }],
    executability: 'EXECUTABLE',
    content_hash: hash('9'),
  }
  const scopedManifest = structuredClone(surfaceManifest)
  scopedManifest.safety = { action: 'NO_RUNNING', scope: ['RUN', 'IMPACT'], reason_codes: ['NO_RUNNING'] }
  scopedManifest.sessions = [restrictedRun, upperBody]
  const execution = normalizeExecution({
    surface_manifest: scopedManifest,
    execution: {
      hasPlan: true,
      hasDay: true,
      isRest: false,
      date: canonicalSession.scheduled_local_date,
      sessions: [restrictedRun, upperBody],
      run: restrictedRun,
      lift: upperBody,
    },
  })
  assert.equal(scheduledRunFromExecution(execution), null)
  assert.equal(scheduledLiftFromExecution(execution)?.session_id, upperBody.session_id)
  assert.equal(hasExecutableSession(execution), true)
})

check('Today, Train, run, lift, and hybrid starts bind the same accepted manifest revision', () => {
  const run = { ...canonicalSession, session_id: 'start-run', workout_family: 'easy_run', content_hash: hash('1') }
  const lift = { ...canonicalSession, session_id: 'start-lift', workout_family: 'strength_upper', content_hash: hash('2'), safety_scope: [] }
  const hybrid = { ...canonicalSession, session_id: 'start-hybrid', workout_family: 'hyrox_station_skill', content_hash: hash('3'), safety_scope: [] }
  const startManifest = structuredClone(surfaceManifest)
  startManifest.safety = { action: 'NO_RUNNING', scope: ['RUN', 'IMPACT'], reason_codes: ['NO_RUNNING'] }
  startManifest.sessions = [run, lift, hybrid]
  const execution = {
    sessions: [run, lift, hybrid],
    surface: { status: 'accepted', identity: startManifest.identity, manifest: startManifest },
  }
  const blockedRun = workoutStartDecision({ execution, sessionId: run.session_id, activity: { kind: 'run' } })
  const safeLift = workoutStartDecision({ execution, sessionId: lift.session_id, activity: { kind: 'lift' } })
  const safeHybrid = workoutStartDecision({ execution, sessionId: hybrid.session_id, activity: { kind: 'hybrid' } })
  assert.equal(blockedRun.allowed, false)
  assert.equal(safeLift.allowed, true)
  assert.equal(safeHybrid.allowed, true)
  assert.deepEqual(safeLift.access.manifest, safeHybrid.access.manifest)
  const backend = plansRoute._test.canonicalWorkoutStartDecision({
    manifest: startManifest,
    access: safeLift.access,
    sessionId: lift.session_id,
    activity: { kind: 'lift' },
  })
  assert.equal(backend.allowed, true)
  assert.deepEqual(backend.access, safeLift.access)
})

check('revision or hash mismatch fails closed for weekly, calendar, and daily execution surfaces', () => {
  const mismatched = structuredClone(surfaceManifest)
  mismatched.sessions[0].session_revision += 1
  const validation = validateSurfaceManifest({ plan, userPlan, manifest: mismatched })
  assert.equal(validation.status, 'blocked')
  assert.deepEqual(validation.reasonCodes, ['SURFACE_REVISION_MISMATCH'])

  const model = buildCalendarModel(plan, userPlan, { surfaceManifest: mismatched })
  assert.equal(model.surface.status, 'blocked')
  assert.equal(model.getWeek(0).days.flatMap((day) => day.sessions).length, 0)
  assert.equal(buildWeeklyRunBrief({ week: model.getWeek(0) }), null)

  const execution = normalizeExecution({
    plan,
    user_plan: userPlan,
    surface_manifest: mismatched,
    execution: { hasPlan: true, hasDay: true, isRest: false, sessions: [canonicalSession], run: canonicalSession },
  })
  assert.equal(execution.surface.status, 'blocked')
  assert.equal(execution.sessions.length, 0)
  assert.equal(hasExecutableSession(execution), false)

  const missing = buildCalendarModel(plan, userPlan)
  assert.equal(missing.surface.status, 'blocked', 'a canonical plan cannot silently fall back when its manifest is missing')
  assert.equal(missing.getWeek(0).days.flatMap((day) => day.sessions).length, 0)
})

check('legacy plans retain their current calendar and execution presentation when no manifest is supplied', () => {
  const legacyPlan = {
    plan_data: { planMode: 'run_only', weeks: [{ week: 1, startDate: '2026-08-17', days: [{ date: '2026-08-17', day: 'Mon', sessions: [{ id: 'legacy-run', kind: 'run', title: 'Easy run', distance_miles: 4 }] }] }] },
  }
  const baseline = buildCalendarModel(legacyPlan, {})
  const explicitAbsent = buildCalendarModel(legacyPlan, {}, { surfaceManifest: null })
  assert.equal(baseline.surface.status, 'legacy')
  assert.deepEqual(explicitAbsent.getWeek(0).days[0].sessions[0], baseline.getWeek(0).days[0].sessions[0])
  const execution = normalizeExecution({ execution: { hasPlan: true, hasDay: true, isRest: false, sessions: [{ id: 'legacy-run', kind: 'run' }], run: { id: 'legacy-run', kind: 'run' } } })
  assert.equal(execution.surface.status, 'legacy')
  assert.equal(execution.run.id, 'legacy-run')
})

const planSource = fs.readFileSync(new URL('../src/pages/Plan.jsx', import.meta.url), 'utf8')
const calendarSource = fs.readFileSync(new URL('../src/components/calendar/ForgedCalendar.jsx', import.meta.url), 'utf8')
const daySource = fs.readFileSync(new URL('../src/components/calendar/ForgedDayView.jsx', import.meta.url), 'utf8')
const dashboardSource = fs.readFileSync(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8')
const logRunSource = fs.readFileSync(new URL('../src/pages/LogRun.jsx', import.meta.url), 'utf8')
const activeWorkoutSource = fs.readFileSync(new URL('../src/pages/ActiveWorkout.jsx', import.meta.url), 'utf8')

for (const project of [
  { name: 'compact-mobile-320', viewport: { width: 320, height: 568 } },
  { name: 'iphone-17', viewport: { width: 402, height: 874 } },
]) {
  check(`${project.name} fixture exposes human copy while preserving canonical fields and overflow guards`, () => {
    assert.match(planSource, /surface_manifest/)
    assert.match(planSource, /Plan details are temporarily unavailable/)
    assert.match(planSource, /This plan changed after it was loaded\. Refresh Train before viewing or starting this workout\./)
    assert.doesNotMatch(planSource, /\{[A-Z][A-Z0-9]*_[A-Z0-9_]+\}/,
      'the athlete blocker never interpolates a raw internal enum')
    assert.doesNotMatch(planSource, />[^<{}]*SURFACE_REVISION_MISMATCH[^<{}]*</)
    assert.doesNotMatch(planSource, />[^<{}]*[A-Z][A-Z0-9]*_[A-Z0-9_]+[^<{}]*</,
      'the athlete blocker never renders a raw underscore enum')
    assert.match(calendarSource, /purposeReasonCodes/)
    assert.match(calendarSource, /targetProvenance/)
    assert.match(daySource, /adjustmentCriteria/)
    assert.match(daySource, /stopCriteria/)
    assert.match(daySource, /capability/)
    assert.match(daySource, /executability/)
    assert.match(calendarSource, /minWidth:\s*0/)
    assert.match(daySource, /overflowWrap:\s*'anywhere'/)
    assert.match(calendarSource, /Plan details and export readiness/)
    assert.match(daySource, /Workout details and export readiness/)
    assert.match(calendarSource, /Technical verification/)
    assert.match(daySource, /Technical verification/)
    assert.doesNotMatch(calendarSource, /\{identity\.(?:decision_id|candidate_id|plan_id)\}/)
    assert.doesNotMatch(daySource, />Decision: \{entry\.decision_id/)
    assert.doesNotMatch(daySource, /\(entry\.evidence_ids \|\| \[\]\)\.join/)
    assert.deepEqual(project.viewport, project.name === 'compact-mobile-320'
      ? { width: 320, height: 568 }
      : { width: 402, height: 874 })

    const preview = goalBackwardV24PlanFixture({
      dateISO: '2026-08-14',
      day: 'Fri',
      featureMode: 'preview',
      safetyAction: 'NO_RUNNING',
      safetyScope: ['RUN', 'IMPACT'],
      safetyReasonCodes: ['NO_RUNNING', 'MATERIAL_CHANGE_REVIEW_REQUIRED'],
      executability: 'RESTRICTED',
      capability: 'FULLY_STRUCTURED',
    })
    const previewBeforePresentation = structuredClone(preview)
    const previewModel = buildCalendarModel(preview.plan, preview.user_plan, {
      surfaceManifest: preview.surface_manifest,
      now: new Date('2026-08-14T12:00:00.000Z'),
    })
    assert.equal(previewModel.surface.status, 'accepted')
    assert.equal(previewModel.surface.manifest.feature_mode, 'preview')
    assert.equal(previewModel.surface.manifest.safety.action, 'NO_RUNNING')
    const previewSession = previewModel.getWeek(0).days.flatMap((day) => day.sessions)[0]
    assert.equal(previewSession.executability, 'RESTRICTED')
    const previewCustomerCopy = [
      phaseLabel(previewModel.phaseForWeek(0)),
      sessionRoleLabel(previewSession.role),
      capabilityLabel(previewSession.capability.classification),
      executabilityLabel(previewSession.executability),
      safetyActionLabel(previewModel.surface.manifest.safety.action),
      safetyScopeList(previewModel.surface.manifest.safety.scope),
      ...previewModel.surface.manifest.safety.reason_codes.map((reason) => reasonCodeLabel(reason)),
    ].join(' · ')
    assert.match(previewCustomerCopy, /Event-specific development · Main workout · Fully supported · Restricted by safety guidance/)
    assert.match(previewCustomerCopy, /No running · Running, Impact activity/)
    assert.match(previewCustomerCopy, /Review required because the plan changed materially/)
    assert.doesNotMatch(previewCustomerCopy, /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/)
    assert.deepEqual(preview, previewBeforePresentation, 'preview source/API values are not changed for presentation')

    const fullRest = goalBackwardV24PlanFixture({
      dateISO: '2026-08-14',
      day: 'Fri',
      featureMode: 'on',
      safetyAction: 'FULL_REST',
      safetyScope: ['ALL'],
      safetyReasonCodes: ['FULL_REST'],
      executability: 'NOT_EXECUTABLE',
      workoutFamily: 'hyrox_station_skill',
      capability: 'MANUAL_COMPONENTS_REQUIRED',
    })
    const fullRestBeforePresentation = structuredClone(fullRest)
    const fullRestModel = buildCalendarModel(fullRest.plan, fullRest.user_plan, {
      surfaceManifest: fullRest.surface_manifest,
      now: new Date('2026-08-14T12:00:00.000Z'),
    })
    const fullRestSession = fullRestModel.getWeek(0).days.flatMap((day) => day.sessions)[0]
    assert.equal(fullRestModel.surface.status, 'accepted')
    assert.equal(fullRestModel.surface.manifest.safety.action, 'FULL_REST')
    assert.equal(fullRestSession.executability, 'NOT_EXECUTABLE')
    assert.equal(fullRestSession.capability.classification, 'MANUAL_COMPONENTS_REQUIRED')
    const fullRestCustomerCopy = [
      phaseLabel(fullRestModel.phaseForWeek(0)),
      sessionRoleLabel(fullRestSession.role),
      capabilityLabel(fullRestSession.capability.classification),
      executabilityLabel(fullRestSession.executability),
      safetyActionLabel(fullRestModel.surface.manifest.safety.action),
      safetyScopeList(fullRestModel.surface.manifest.safety.scope),
      ...fullRestModel.surface.manifest.safety.reason_codes.map((reason) => reasonCodeLabel(reason)),
    ].join(' · ')
    assert.match(fullRestCustomerCopy, /Supporting session · Manual setup required · Cannot be started or exported/)
    assert.match(fullRestCustomerCopy, /Full rest · All training/)
    assert.doesNotMatch(fullRestCustomerCopy, /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/)
    assert.deepEqual(fullRest, fullRestBeforePresentation, 'full-rest source/API values are not changed for presentation')
  })
}

check('start pages revalidate canonical safety before navigation and plan-linked completion', () => {
  assert.match(dashboardSource, /authorizeWorkoutStart/)
  assert.match(logRunSource, /authorizeWorkoutStart/)
  assert.match(logRunSource, /workoutStartAccess/)
  assert.match(activeWorkoutSource, /authorizeWorkoutStart/)
  assert.match(activeWorkoutSource, /WORKOUT_START_ACCESS/)
})

console.log(`\nGOAL-BACKWARD SURFACES SMOKE OK (${passed} checks)`)
