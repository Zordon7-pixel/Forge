// Standalone Node ESM smoke for the Forged Training Calendar model (H2).
// Run: cd frontend && node test/planCalendar.smoke.mjs
// No test framework — pure asserts so it runs anywhere Node runs.

import assert from 'node:assert/strict'
import {
  canonicalWorkoutLabel,
  parseLocalDate,
  toISODate,
  addDays,
  startOfWeekMonday,
  countdownDays,
  feasibilityLabel,
  getGoal,
  getPlanMode,
  planModeLabel,
  buildWeekDays,
  buildCalendarModel,
  calendarDateRange,
  buildMonthGrid,
  dayHasLift,
  dayMarks,
  dayStatus,
  monthMark,
  normalizePrescription,
  normalizeLiftExercisePrescription,
  normalizeSession,
  normalizeRecordedRun,
  indexRecordedRuns,
  dayWithRecordedRuns,
  goalWithRace,
  racePlanReview,
} from '../src/lib/planCalendar.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

const WEEK_START = parseLocalDate('2026-07-13') // Monday

check('race sessions are labeled as race day rather than long runs', () => {
  assert.equal(canonicalWorkoutLabel({ kind: 'run', type: 'race', title: 'Army Ten-Miler' }), 'Race day')
  assert.equal(canonicalWorkoutLabel({ kind: 'run', type: 'long', title: 'Long aerobic run' }), 'Long run')
  assert.equal(canonicalWorkoutLabel({ kind: 'run', type: 'race_pace', title: 'Goal pace repeats' }), 'Race-pace workout')
})

// ---------------------------------------------------------------------------
// (a) legacy week.sessions — dates + ids preserved
// ---------------------------------------------------------------------------
check('a: legacy week.sessions preserves ids and derives dates', () => {
  const week = {
    week: 1,
    sessions: [
      { id: 'run-mon', day: 'Mon', type: 'run', title: 'Easy Run', distance_miles: 4 },
      { id: 'run-wed', day: 'Wed', type: 'run', title: 'Tempo', distance_miles: 6 },
      { id: 'long-sat', day: 'Sat', type: 'run', title: 'Long Run', distance_miles: 10 },
    ],
  }
  const days = buildWeekDays(week, WEEK_START, { runOnly: true })
  assert.equal(days.length, 7)
  const mon = days[0]
  assert.equal(mon.dayLabel, 'Mon')
  assert.equal(mon.dateISO, '2026-07-13')
  assert.equal(mon.sessions[0].id, 'run-mon')
  assert.equal(mon.sessions[0].distanceMiles, 4)
  // Wednesday is slot 2 -> 2026-07-15
  assert.equal(days[2].dateISO, '2026-07-15')
  assert.equal(days[2].sessions[0].id, 'run-wed')
  // Saturday is slot 5 -> 2026-07-18
  assert.equal(days[5].dateISO, '2026-07-18')
  // Tue/Thu/Fri/Sun with no session -> rest
  assert.equal(days[1].isRest, true)
  assert.equal(days[3].isRest, true)
})

// ---------------------------------------------------------------------------
// (b) legacy week.days (legacy-shaped day entries, no nested sessions[])
// ---------------------------------------------------------------------------
check('b: legacy week.days renders one session per day', () => {
  const week = {
    week: 2,
    days: [
      { id: 'd-mon', day: 'Mon', type: 'run', title: 'Recovery', distance_miles: 3 },
      { id: 'd-tue', day: 'Tue', type: 'rest', title: 'Rest day' },
    ],
  }
  const days = buildWeekDays(week, WEEK_START, { runOnly: true })
  assert.equal(days[0].sessions.length, 1)
  assert.equal(days[0].sessions[0].id, 'd-mon')
  // rest-typed legacy day -> no sessions -> rest
  assert.equal(days[1].isRest, true)
})

check('b2: legacy id fallback and inferred lift mode match the backend', () => {
  const plan = {
    type: '10K',
    plan_data: {
      weeks: [{ week: 1, days: [
        { day: 'Mon', type: 'run', title: 'Easy Run', distance_miles: 3 },
        { day: 'Wed', type: 'strength', title: 'Full Body' },
      ] }],
    },
  }
  assert.equal(getPlanMode(plan), 'hybrid_maintain')
  const model = buildCalendarModel(plan, { started_at: '2026-07-13' }, { now: WEEK_START })
  assert.equal(model.runOnly, false)
  assert.equal(model.getWeek(0).days[0].sessions[0].id, '0')
  assert.equal(model.getWeek(0).days[2].sessions[0].id, '1')
  assert.equal(dayHasLift(model.getWeek(0).days[2]), true)
})

check('b3: duplicate legacy weekdays preserve a same-day run and lift', () => {
  const week = { sessions: [
    { day: 'Mon', type: 'run', title: 'Easy Run' },
    { day: 'Mon', type: 'strength', title: 'Upper Strength' },
  ] }
  const days = buildWeekDays(week, WEEK_START, { runOnly: false })
  assert.equal(days[0].sessions.length, 2)
  assert.deepEqual(days[0].sessions.map((session) => session.id), ['0', '1'])
  assert.equal(dayHasLift(days[0]), true)
})

// ---------------------------------------------------------------------------
// (c) schema-v2 nested day.sessions — 0, 1, and 2 sessions
// ---------------------------------------------------------------------------
check('c: schema-v2 handles 0/1/2 sessions per day', () => {
  const week = {
    week: 1,
    startDate: '2026-07-13',
    days: [
      { date: '2026-07-13', day: 'Mon', sessions: [
        { id: 's-run', kind: 'run', prescription: { title: 'Intervals', distanceMiles: 5 } },
        { id: 's-lift', kind: 'lift', prescription: { title: 'Lower Strength' } },
      ], orderGuidance: 'Run first; lift 6h later' },
      { date: '2026-07-14', day: 'Tue', sessions: [
        { id: 's-easy', kind: 'run', prescription: { title: 'Easy', distanceMiles: 3 } },
      ] },
      { date: '2026-07-15', day: 'Wed', sessions: [] },
    ],
  }
  const days = buildWeekDays(week, WEEK_START, { runOnly: false })
  assert.equal(days[0].sessions.length, 2)
  assert.equal(days[0].orderGuidance, 'Run first; lift 6h later')
  assert.equal(dayHasLift(days[0]), true)
  assert.equal(days[0].sessions[0].title, 'Intervals')
  assert.equal(days[1].sessions.length, 1)
  assert.equal(days[2].isRest, true) // zero sessions -> rest
})

check('c2: schema-v2 fallback ids match backend anchors and rest entries are filtered', () => {
  const week = {
    days: [{ date: '2026-07-13', day: 'Mon', sessions: [
      { kind: 'run', type: 'easy' },
      { kind: 'rest', type: 'rest' },
    ] }],
  }
  const days = buildWeekDays(week, WEEK_START, { runOnly: false })
  assert.equal(days[0].sessions.length, 1)
  assert.equal(days[0].sessions[0].id, '2026-07-13-run-0')
})

check('c3: date-less schema-v2 fallback ids match backend weekday anchors', () => {
  const week = { days: [{ day: 'Mon', sessions: [
    { kind: 'run', type: 'easy' },
    { kind: 'lift', type: 'strength' },
  ] }] }
  const days = buildWeekDays(week, WEEK_START, { runOnly: false })
  assert.deepEqual(days[0].sessions.map((session) => session.id), ['Mon-run-0', 'Mon-lift-1'])
})

// ---------------------------------------------------------------------------
// (d) run-only produces no lift sessions / placeholders
// ---------------------------------------------------------------------------
check('d: run-only strips lift sessions entirely', () => {
  const plan = {
    weeks: 1,
    plan_data: {
      planMode: 'run_only',
      weeks: [{ week: 1, startDate: '2026-07-13', days: [
        { date: '2026-07-13', day: 'Mon', sessions: [
          { id: 'r', kind: 'run', prescription: { title: 'Easy', distanceMiles: 4 } },
          { id: 'l', kind: 'lift', prescription: { title: 'Should not show' } },
        ] },
      ] }],
    },
  }
  assert.equal(getPlanMode(plan), 'run_only')
  const model = buildCalendarModel(plan, {}, { now: WEEK_START })
  assert.equal(model.runOnly, true)
  const day = model.getWeek(0).days[0]
  assert.equal(day.sessions.length, 1)
  assert.equal(dayHasLift(day), false)
  assert.equal(model.getWeek(0).days.some((d) => dayHasLift(d)), false)
})

// ---------------------------------------------------------------------------
// (e) completed status
// ---------------------------------------------------------------------------
check('e: completed status reflects completedSet', () => {
  const week = {
    week: 1,
    days: [
      { date: '2026-07-13', day: 'Mon', sessions: [
        { id: 'a', kind: 'run', prescription: { title: 'Run', distanceMiles: 4 } },
        { id: 'b', kind: 'lift', prescription: { title: 'Lift' } },
      ] },
    ],
  }
  const days = buildWeekDays(week, WEEK_START, { runOnly: false })
  const noneDone = new Set()
  assert.equal(dayStatus(days[0], noneDone), 'planned')
  const partial = new Set(['a'])
  assert.equal(dayStatus(days[0], partial), 'planned')
  const allDone = new Set(['a', 'b'])
  assert.equal(dayStatus(days[0], allDone), 'completed')
  const marks = dayMarks(days[0], allDone)
  assert.equal(marks.length, 2)
  assert.equal(marks[0].state, 'completed')
})

// ---------------------------------------------------------------------------
// (f) local-date derivation around DST + week/year boundaries
// ---------------------------------------------------------------------------
check('f: local-date math is DST- and boundary-safe', () => {
  // US spring-forward 2026-03-08. Adding a day must not drift the calendar date.
  const beforeDst = parseLocalDate('2026-03-07')
  assert.equal(toISODate(addDays(beforeDst, 1)), '2026-03-08')
  assert.equal(toISODate(addDays(beforeDst, 2)), '2026-03-09')
  // Fall-back 2026-11-01.
  const beforeFall = parseLocalDate('2026-10-31')
  assert.equal(toISODate(addDays(beforeFall, 1)), '2026-11-01')
  // Year boundary.
  assert.equal(toISODate(addDays(parseLocalDate('2026-12-31'), 1)), '2027-01-01')
  // Monday anchor for a Sunday must reach back to the same week's Monday.
  const sunday = parseLocalDate('2026-07-19')
  assert.equal(toISODate(startOfWeekMonday(sunday)), '2026-07-13')
  // 'YYYY-MM-DD' must NOT drift a day (the classic UTC bug).
  assert.equal(toISODate(parseLocalDate('2026-07-13')), '2026-07-13')
  // Countdown across DST is whole days.
  assert.equal(countdownDays('2026-10-11', '2026-07-12'), 91)
})

// ---------------------------------------------------------------------------
// (g) month grid + day selection helpers
// ---------------------------------------------------------------------------
check('g: month grid marks scheduled dates and finds days', () => {
  const plan = {
    weeks: 1,
    plan_data: {
      planMode: 'hybrid_maintain',
      goal: { name: 'Army Ten-Miler', date: '2026-10-11', distanceMiles: 10, goalType: 'pr' },
      weeks: [{ week: 1, startDate: '2026-07-13', phase: 'base', days: [
        { date: '2026-07-13', day: 'Mon', sessions: [
          { id: 'r', kind: 'run', prescription: { title: 'Easy', distanceMiles: 4 } },
          { id: 'l', kind: 'lift', prescription: { title: 'Full Body' } },
        ] },
        { date: '2026-07-15', day: 'Wed', sessions: [
          { id: 'r2', kind: 'run', prescription: { title: 'Tempo', distanceMiles: 6 } },
        ] },
        { date: '2026-07-16', day: 'Thu', sessions: [] },
      ] }],
    },
  }
  const model = buildCalendarModel(plan, {}, { now: WEEK_START })
  assert.equal(model.mode, 'hybrid_maintain')
  assert.equal(planModeLabel(model.mode), 'Maintain strength')
  assert.equal(model.goal.name, 'Army Ten-Miler')

  const found = model.findDayByDate('2026-07-13')
  assert.ok(found)
  assert.equal(monthMark(found), 'hybrid')
  assert.equal(monthMark(model.findDayByDate('2026-07-15')), 'run')
  assert.equal(monthMark(model.findDayByDate('2026-07-16')), 'rest')

  const grid = buildMonthGrid(model, '2026-07-13', { todayISO: '2026-07-13' })
  assert.equal(grid.rows.length, 6)
  assert.equal(grid.rows[0].length, 7)
  // Find the July 13 cell and confirm mark + today flag.
  const flat = grid.rows.flat()
  const cell = flat.find((c) => c.dateISO === '2026-07-13')
  assert.ok(cell)
  assert.equal(cell.inMonth, true)
  assert.equal(cell.isToday, true)
  assert.equal(cell.mark, 'hybrid')
  // A date with no plan has no mark.
  const empty = flat.find((c) => c.dateISO === '2026-07-20')
  assert.equal(empty.mark, null)
})

check('g2: plan goal exposes race ownership and editable race truth overlays stale metadata', () => {
  const planGoal = getGoal({ plan_data: { goal: {
    raceId: 'race-1',
    name: 'Old name',
    date: '2026-10-11',
    distanceMiles: 10,
    goalTimeSeconds: 5400,
    goalPaceLabel: '9:00/mi',
    anchoredBy: { runDate: '2026-07-01' },
    course: { state: 'verified', elevationGainFt: 620 },
  } } })
  assert.equal(planGoal.raceId, 'race-1')
  const updated = goalWithRace(planGoal, {
    id: 'race-1',
    race_name: 'Army Ten-Miler',
    race_date: '2026-10-18',
    distance_miles: 10,
    goal_time_seconds: 5100,
    location: 'Washington, DC',
  })
  assert.equal(updated.name, 'Army Ten-Miler')
  assert.equal(updated.dateISO, '2026-10-18')
  assert.equal(updated.goalTimeSeconds, 5100)
  assert.equal(updated.goalPaceSecondsPerMile, 510)
  assert.equal(updated.goalPaceLabel, null)
  assert.equal(updated.anchoredBy, null)
  assert.equal(updated.course, null)
})

check('g2b: a goal-time-only race edit preserves trusted course facts', () => {
  const course = { state: 'verified', elevationGainFt: 620 }
  const goal = {
    raceId: 'race-1',
    name: 'Army Ten-Miler',
    dateISO: '2026-10-11',
    distanceMiles: 10,
    goalTimeSeconds: 5400,
    course,
  }
  const updated = goalWithRace(goal, {
    id: 'race-1',
    race_name: 'Army Ten-Miler',
    race_date: '2026-10-11',
    distance_miles: 10,
    goal_time_seconds: 5100,
    course_intelligence: { trusted: true },
  })
  assert.deepEqual(updated.course, course)
  assert.equal(updated.goalTimeSeconds, 5100)
})

check('g2c: persisted race target review ignores notes but catches plan inputs', () => {
  const goal = getGoal({ plan_data: { goal: {
    raceId: 'race-1',
    name: 'Army Ten-Miler',
    date: '2026-10-11',
    distanceMiles: 10,
    goalTimeSeconds: 5400,
    raceTarget: {
      raceId: 'race-1',
      name: 'Army Ten-Miler',
      date: '2026-10-11',
      distanceMiles: 10,
      location: 'Washington, DC',
      goalTimeSeconds: 5400,
    },
  } } })
  const unchanged = racePlanReview(goal, {
    id: 'race-1', race_name: 'Army Ten-Miler', race_date: '2026-10-11', distance_miles: 10,
    location: 'Washington, DC', goal_time_seconds: 5400, notes: 'Updated note', status: 'upcoming',
  })
  assert.deepEqual(unchanged, { required: false, changedFields: [] })

  const edited = racePlanReview(goal, {
    id: 'race-1', race_name: 'Army Ten-Miler', race_date: '2026-10-18', distance_miles: 10,
    location: 'Washington, DC', goal_time_seconds: 5220,
  })
  assert.equal(edited.required, true)
  assert.deepEqual(edited.changedFields, ['date', 'goal_time'])
})

check('g2d: race review never compares a different protected race', () => {
  const review = racePlanReview({
    raceId: 'race-a',
    raceTarget: { raceId: 'race-a', name: 'A1', dateISO: '2026-09-20', distanceMiles: 13.1, location: 'Yonkers, NY', goalTimeSeconds: 7200 },
  }, {
    id: 'race-b', race_name: 'A2', race_date: '2026-10-11', distance_miles: 10, location: 'Washington, DC', goal_time_seconds: 5400,
  })
  assert.deepEqual(review, { required: false, changedFields: [] })
})

check('g3: recorded runs index by real date while non-run activities stay out', () => {
  const runsByDate = indexRecordedRuns([
    { id: 'run-1', date: '2026-07-14', workout_type: 'Running', distance_miles: 3.11, duration_seconds: 1800 },
    { id: 'walk-1', date: '2026-07-14', workout_type: 'Walking', distance_miles: 1 },
  ])
  assert.equal(runsByDate.get('2026-07-14').length, 1)
  assert.equal(runsByDate.get('2026-07-14')[0].paceSecondsPerMile, 1800 / 3.11)
  assert.equal(normalizeRecordedRun({ id: 'walk', date: '2026-07-14', workout_type: 'Walking' }), null)

  const recordedDay = dayWithRecordedRuns(null, '2026-07-14', runsByDate)
  assert.equal(recordedDay.hasPlan, false)
  assert.equal(recordedDay.isRest, true)
  assert.equal(recordedDay.activities[0].id, 'run-1')
})

check('g4: month grid marks an unplanned recorded run without inventing a plan day', () => {
  const plan = {
    weeks: 1,
    plan_data: { planMode: 'run_only', weeks: [{ week: 1, startDate: '2026-07-13', days: [] }] },
  }
  const model = buildCalendarModel(plan, {}, { now: WEEK_START })
  const recordedRunsByDate = indexRecordedRuns([
    { id: 'extra', date: '2026-07-20', workout_type: 'Running', distance_miles: 2, duration_seconds: 1200 },
  ])
  const grid = buildMonthGrid(model, '2026-07-13', { todayISO: '2026-07-14', recordedRunsByDate })
  const cell = grid.rows.flat().find((item) => item.dateISO === '2026-07-20')
  assert.equal(cell.hasPlan, false)
  assert.equal(cell.hasRecordedRun, true)
  assert.equal(cell.mark, 'run')
  assert.equal(cell.state, 'recorded')
})

check('g5: active calendar range is bounded to plan dates and includes today', () => {
  const plan = {
    weeks: 1,
    plan_data: { planMode: 'run_only', weeks: [{ week: 1, startDate: '2026-07-13', days: [] }] },
  }
  const model = buildCalendarModel(plan, {}, { now: WEEK_START })
  assert.deepEqual(calendarDateRange(model, '2026-07-22'), {
    start_date: '2026-07-13',
    end_date: '2026-07-22',
  })
})

// ---------------------------------------------------------------------------
// (h) recovery prescription integrity + execution payload
// ---------------------------------------------------------------------------
check('h: stale recovery hill work is repaired before display or execution', () => {
  const raw = {
    id: 'recovery-after-long-run',
    kind: 'run',
    type: 'recovery',
    title: 'Recovery run',
    distance_miles: 0.9,
    target_zone: 'Zone 1-2',
    intensity: 'Recovery',
    warmup: ['12 min easy running', '4 x 20 sec relaxed strides'],
    steps: ['6-8 x 60 sec uphill', 'Jog down fully between repetitions'],
    cooldown: ['10 min easy running'],
  }
  const normalized = normalizeSession(raw)
  assert.equal(normalized.type, 'recovery')
  assert.equal(normalized.prescription.target_zone, 'Zone 1-2')
  assert.match(normalized.prescription.pace_target, /fully conversational/i)
  assert.ok(normalized.prescription.steps.some((step) => /stay in zone 1-2/i.test(step)))
  assert.ok(normalized.prescription.steps.every((step) => !/hill|repeat|interval/i.test(step)))
  assert.deepEqual(normalized.raw.steps, normalized.prescription.steps)
  assert.match(raw.steps[0], /uphill/) // source data remains immutable
})

check('h2: flat prescriptions remain complete for start/watch consumers', () => {
  const raw = { id: 'easy', kind: 'run', type: 'easy', title: 'Easy run', pace_target: '10:30/mi', target_zone: 'Zone 2', steps: ['Stay easy'] }
  const normalized = normalizeSession(raw)
  assert.equal(normalized.prescription.pace_target, '10:30/mi')
  assert.equal(normalized.prescription.target_zone, 'Zone 2')
  assert.deepEqual(normalized.prescription.steps, ['Stay easy'])
  assert.equal(normalizePrescription(raw).adjusted, false)
})

check('h3: genuine hard workouts are never mislabeled or rewritten', () => {
  const raw = { kind: 'run', type: 'hills', title: 'Controlled hill repeats', target_zone: 'Zone 3', steps: ['6 x 60 sec uphill'] }
  const normalized = normalizeSession(raw)
  assert.equal(normalized.title, 'Controlled hill repeats')
  assert.deepEqual(normalized.prescription.steps, ['6 x 60 sec uphill'])
  assert.equal(normalizePrescription(raw).adjusted, false)
})

check('h4: converted steady work cannot remain inside a recovery run', () => {
  const normalized = normalizeSession({ kind: 'run', type: 'recovery', title: 'Recovery run', target_zone: 'Zone 1-2', pace_target: 'Comfortably steady', steps: ['Run the middle continuously at steady effort'] })
  assert.ok(normalized.prescription.steps.some((step) => /stay in zone 1-2/i.test(step)))
  assert.ok(normalized.prescription.steps.every((step) => !/steady effort/i.test(step)))
})

check('h4b: incidental moderate mobility copy does not trigger recovery repair', () => {
  const raw = { kind: 'run', type: 'recovery', title: 'Recovery run', target_zone: 'Zone 1-2', cooldown: ['Optional moderate mobility after the walk'] }
  const normalized = normalizeSession(raw)
  assert.equal(normalized.adjusted, false)
  assert.deepEqual(normalized.prescription.cooldown, raw.cooldown)
})

check('h5: unsupported legacy lift percentages fall back to honest effort calibration', () => {
  const normalized = normalizeLiftExercisePrescription({ name: 'Dumbbell bench press', load: '70-80% estimated max', rpe: '7-8' })
  assert.equal(normalized.load, 'Choose load for RPE/RIR 7-8')
  assert.match(normalized.loadSource, /no matching logged set/i)
  const anchored = normalizeLiftExercisePrescription({ name: 'Dumbbell bench press', load: '52.5 lb starting load', loadSource: 'Conservative estimate from a recent set', rpe: '7-8' })
  assert.equal(anchored.load, '52.5 lb starting load')
})

check('p5: calendar adapter preserves engine explanations and complete prescriptions', () => {
  const whyThisPlan = {
    summary: 'This block needs a successful checkpoint before the goal can be treated as supported.',
    baseline: { value: 18.5, confidence: 'trusted', trustedWeeks: 3, source: 'recorded_complete_weeks' },
    endurance: { value: 8, confidence: 'trusted', source: 'recorded_endurance_runs' },
    reason_codes: ['PACE_EQUIVALENCY_USED'],
  }
  const keyQualitySession = {
    date: '2026-07-15',
    workout_id: 'threshold_intervals',
    title: 'Threshold intervals',
    purpose: 'Develop sustainable race-specific speed.',
  }
  const longRunTarget = { date: '2026-07-18', distance_miles: 9, duration_min: 90 }
  const planData = {
    planMode: 'hybrid_maintain',
    overall_feasibility: 'stretch',
    goal_feasibilities: [{
      race_id: 'race-a1',
      race_name: 'Yonkers Half Marathon',
      feasibility: 'stretch',
      full_training_weeks: 7,
      reasons: ['PACE_EQUIVALENCY_USED'],
      pace: { anchorClass: 'equivalent', anchorAgeDays: 12 },
    }],
    whyThisPlan,
    weekly_curve: [{ week: 1, targetWeeklyMiles: 20, targetLongMiles: 9 }],
    peak_long_run: { week: 5, distance_miles: 11, date: '2026-08-15' },
    generationTraceSchemaVersion: 1,
    engineVersion: 'race-plan-v2',
    policyVersion: 'race-plan-policy-v1',
    invariantVersion: 'plan-invariants-v2',
    inputHash: 'input-hash',
    candidateHash: 'candidate-hash',
    inputSummary: { recentRunCount: 8, mileageBaseline: { meaningfulRunCount: 6 } },
    trainingEvidence: [{ id: 'evidence-1', publisher: 'Reviewed source' }],
    goals: [{ raceId: 'race-a1', name: 'Yonkers Half Marathon', date: '2026-09-20', distanceMiles: 13.109, goalType: 'pr' }],
    weeks: [{
      week: 1,
      startDate: '2026-07-13',
      phase: 'build',
      purpose: 'Build endurance and sustainable speed toward race demand.',
      keyQualitySession,
      longRunTarget,
      strengthIntent: 'One scheduled strength session preserves the selected strength floor.',
      days: [{
        date: '2026-07-15',
        day: 'Wed',
        sessions: [{
          id: 'quality-1',
          kind: 'run',
          type: 'threshold',
          title: 'Threshold intervals',
          display_name: 'Hold the Line',
          prescription: {
            title: 'Threshold intervals',
            warmup: ['10 min easy'],
            steps: ['4 x 5 min threshold', '2 min easy between reps'],
            cooldown: ['10 min easy'],
          },
        }],
      }],
    }],
  }
  const model = buildCalendarModel({ plan_data: planData }, {}, { now: WEEK_START })
  const week = model.getWeek(0)
  const session = week.days[2].sessions[0]

  assert.equal(feasibilityLabel('supported'), 'On track')
  assert.equal(model.feasibility.status, 'stretch')
  assert.equal(model.feasibility.label, 'Stretch target')
  assert.equal(model.feasibility.goals[0].raceName, 'Yonkers Half Marathon')
  assert.strictEqual(model.whyThisPlan, whyThisPlan)
  assert.strictEqual(model.engineMetadata.raw, planData)
  assert.deepEqual(model.engineMetadata.weeklyCurve, planData.weekly_curve)
  assert.equal(model.engineMetadata.candidateHash, 'candidate-hash')
  assert.equal(week.purpose, planData.weeks[0].purpose)
  assert.strictEqual(week.keyQualitySession, keyQualitySession)
  assert.strictEqual(week.longRunTarget, longRunTarget)
  assert.equal(week.strengthIntent, planData.weeks[0].strengthIntent)
  assert.equal(session.title, 'Threshold intervals')
  assert.equal(session.motivationalTitle, 'Hold the Line')
  assert.deepEqual(session.prescription.steps, ['4 x 5 min threshold', '2 min easy between reps'])
})

check('assignment-level removal hides only the selected upcoming workout', () => {
  const plan = {
    plan_data: {
      schemaVersion: 2,
      planMode: 'hybrid_maintain',
      weeks: [{
        week: 1,
        startDate: '2026-07-13',
        days: [{
          date: '2026-07-13',
          day: 'Mon',
          sessions: [
            { id: 'run-kept', kind: 'run', title: 'Easy run' },
            { id: 'lift-removed', kind: 'lift', title: 'Strength build' },
          ],
        }],
      }],
    },
  }
  const model = buildCalendarModel(plan, {
    started_at: '2026-07-13',
    progress: { removedSessionIds: ['lift-removed'] },
  }, { now: WEEK_START })
  const monday = model.getWeek(0).days[0]
  assert.deepEqual(monday.sessions.map((session) => session.id), ['run-kept'])
  assert.equal(monday.isRest, false)
})

console.log(`\nplanCalendar smoke: ${passed} checks passed`)
