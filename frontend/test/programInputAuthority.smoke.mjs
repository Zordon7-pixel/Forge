import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { scheduleDraftFromPlan, toggleTrainingDay, validateScheduleDraft, buildScheduleRebuildRequest } from '../src/lib/planSchedule.js'
import { racePlanGenerationTarget } from '../src/lib/planCalendar.js'
const all = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
const draft = scheduleDraftFromPlan({ schedulePreferences: { trainingDays: all, runDaysPerWeek: 7 } })
assert.equal(draft.runDaysPerWeek, 7)
assert.equal(validateScheduleDraft(draft), '')
const fewer = toggleTrainingDay(draft, 'Mon')
assert.equal(fewer.runDaysPerWeek, 7)
assert.match(validateScheduleDraft(fewer), /cannot exceed/)
const plan = { planMode: 'hybrid_maintain', schedulePreferences: { runEligibleWeekdays: all, liftEligibleWeekdays: all }, strengthPolicy: { enabled: true, sessionsPerWeek: 7 } }
assert.equal(buildScheduleRebuildRequest({ planData: plan, draft }).body.target.liftDaysPerWeek, 7)
assert.equal(racePlanGenerationTarget({ plan_data: plan }, { lift_days_per_week: 7 }).liftDaysPerWeek, 7)
const savedFour = { plan_data: { ...plan, schedulePreferences: { runDaysPerWeek: 4, runEligibleWeekdays: all, liftEligibleWeekdays: all }, strengthPolicy: { enabled: true, sessionsPerWeek: 4 } } }
const updatedSeven = racePlanGenerationTarget(savedFour, { run_days_per_week: 7, lift_days_per_week: 7, preferred_workout_days: JSON.stringify(all) })
assert.equal(updatedSeven.runDaysPerWeek, 7)
assert.equal(updatedSeven.liftDaysPerWeek, 7)
const updatedZero = racePlanGenerationTarget(savedFour, { run_days_per_week: 4, lift_days_per_week: 0 })
assert.equal(updatedZero.planMode, 'run_only')
assert.equal(updatedZero.liftDaysPerWeek, 0)
assert.equal(updatedZero.liftingEnabled, false)
const source = readFileSync(new URL('../src/pages/PlanCatalog.jsx', import.meta.url), 'utf8')
const start = source.indexOf('  const loadPrefill = async () => {')
const end = source.indexOf('  const openGoal = ', start)
assert.ok(start > 0 && end > start)
const state = {}
let release
const pending = new Promise(resolve => { release = resolve })
const sandbox = { api: { get: () => pending }, sortDays: days => days,
  preferenceEditRevision: { current: 0 }, prefillRequestRevision: { current: 0 },
  setError: error => { throw Error(error) }, navigate: () => { throw Error('Unexpected navigation') }, console }
for (const field of ['PrefillLoading','TrainingDays','RunDaysPerWeek','LiftingEnabled','LiftDaysPerWeek','LiftEligibleWeekdays','StrengthMode']) sandbox[`set${field}`] = value => { state[field] = value }
vm.createContext(sandbox)
vm.runInContext(`${source.slice(start, end)}; globalThis.prefill = loadPrefill`, sandbox)
const inFlight = sandbox.prefill()
Object.assign(state, { RunDaysPerWeek: 4, LiftDaysPerWeek: 4, LiftingEnabled: true })
sandbox.preferenceEditRevision.current += 1
release({ data: { runDaysPerWeek: 3, liftDaysPerWeek: 0, liftingEnabled: false, inferredTrainingDays: ['Tue','Thu','Sat'] } })
await inFlight
assert.equal(state.RunDaysPerWeek, 4)
assert.equal(state.LiftDaysPerWeek, 4)
assert.equal(state.LiftingEnabled, true)
console.log('PROGRAM INPUT AUTHORITY OK: late prefill, seven-day Train rebuild and no silent weekday downshift')
