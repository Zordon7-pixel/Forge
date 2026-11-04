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
const sandbox = { getAuthSession: () => ({ token: 'synthetic-session' }), isAuthSessionCurrent: () => true,
  api: { get: () => pending }, sortDays: days => days,
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

// Closing/replacing the dialog invalidates late failures as well as successes.
sandbox.api.get = () => Promise.reject(new Error('obsolete prefill'))
const obsoleteFailure = sandbox.prefill()
sandbox.prefillRequestRevision.current += 1
await obsoleteFailure
sandbox.isAuthSessionCurrent = () => false
await sandbox.prefill()
console.log('PASS prefill close/replacement and auth-session stale failure fences')

// Execute the actual ProProvider request/lifecycle closures with a minimal hook
// adapter and deferred transport. This is isolated unit coverage, NOT React DOM,
// native-plugin or browser E2E acceptance (see raceSearchBrowser.integration.mjs).
const proSource = readFileSync(new URL('../src/context/ProContext.jsx', import.meta.url), 'utf8')
  .replace(/^import .+\n/gm, '')
  .replace(/export function /g, 'function ')
  .replace('return <ProContext.Provider value={{ ...state, refreshPro }}>{children}</ProContext.Provider>', 'return { refreshPro }')
const states = [], requests = [], cleanups = [], nativeHandlers = new Map(), authListeners = new Set()
let authSession = { token: 'synthetic-a', generation: 0 }, visibility, removals = 0
const proSandbox = {
  createContext: () => ({}), useContext: () => ({}), useCallback: fn => fn,
  useRef: current => ({ current }), useState: initial => [initial, state => states.push(state)],
  useEffect: effect => cleanups.push(effect()), AbortController, console,
  getAuthSession: () => ({ ...authSession }),
  isAuthSessionCurrent: captured => Boolean(captured?.token) && captured.token === authSession.token && captured.generation === authSession.generation,
  isLoggedIn: () => Boolean(authSession.token),
  subscribeAuthSession: fn => { authListeners.add(fn); return () => authListeners.delete(fn) },
  api: { get: (url, config) => new Promise((resolve, reject) => requests.push({ url, config, resolve, reject })) },
  Capacitor: { isNativePlatform: () => true },
  App: { addListener: (name, fn) => { nativeHandlers.set(name, fn); return Promise.resolve({ remove: () => { removals++; nativeHandlers.delete(name) } }) } },
  document: { visibilityState: 'visible', addEventListener: (_name, fn) => { visibility = fn }, removeEventListener: () => { visibility = null } },
}
vm.createContext(proSandbox)
vm.runInContext(`${proSource}; globalThis.provider = ProProvider({children:null})`, proSandbox)
const response = source => ({ data: { user: { entitlement: { effectivePremiumAccess: source !== 'free', accessSource: source } } } })
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
assert.equal(requests.length, 1)
const slow = proSandbox.provider.refreshPro()
assert.equal(proSandbox.provider.refreshPro(), slow, 'same-session refresh returns the same Promise')
visibility(); nativeHandlers.get('resume')(); nativeHandlers.get('appStateChange')({ isActive: true })
assert.equal(requests.length, 1, 'web/native simultaneous resume coalesces')
assert.equal(states.at(-1).loading, true)
await new Promise(resolve => setTimeout(resolve, 8000))
assert.equal(states.at(-1).loading, true, 'eight-second unresolved auth remains visibly loading')
requests[0].resolve(response('subscription')); assert.equal(await slow, true)
assert.equal(states.at(-1).isPro, true)
// Start old-account refresh, then login to a new account before it resolves.
const oldRefresh = proSandbox.provider.refreshPro()
authSession = { token: 'synthetic-b', generation: 1 }; for (const listener of authListeners) listener()
assert.equal(requests.length, 3)
assert.equal(requests[1].config.signal.aborted, true)
requests[2].resolve(response('free')); await flush()
requests[1].resolve(response('subscription')); assert.equal(await oldRefresh, false)
assert.equal(states.at(-1).accessSource, 'free', 'stale premium success cannot overwrite login')
const failure = proSandbox.provider.refreshPro(); requests.at(-1).reject(new Error('transport failed')); await failure
assert.equal(states.at(-1).isPro, false)
assert.match(states.at(-1).error, /Retry/)
const retry = proSandbox.provider.refreshPro(); requests.at(-1).resolve(response('beta')); assert.equal(await retry, true)
assert.equal(states.at(-1).accessSource, 'beta')
// Stale failure after a second login cannot demote the new account either.
const obsolete = proSandbox.provider.refreshPro()
const obsoleteRequest = requests.at(-1)
authSession = { token: 'synthetic-c', generation: 2 }; for (const listener of authListeners) listener()
requests.at(-1).resolve(response('subscription')); await flush()
obsoleteRequest.reject(new Error('obsolete failure')); await obsolete
assert.equal(states.at(-1).isPro, true)
// Logout clears previous access immediately and never requests /auth/me.
const countBeforeLogout = requests.length
authSession = { token: null, generation: 3 }; for (const listener of authListeners) listener()
assert.equal(states.at(-1).isPro, false); assert.equal(states.at(-1).loading, false)
assert.equal(requests.length, countBeforeLogout)
authSession = { token: 'synthetic-d', generation: 4 }; for (const listener of authListeners) listener()
const late = requests.at(-1), stateCount = states.length
for (const cleanup of cleanups) cleanup()
assert.equal(late.config.signal.aborted, true)
late.resolve(response('subscription')); await flush()
assert.equal(states.length, stateCount, 'unmounted response cannot publish state')
assert.equal(authListeners.size, 0); assert.equal(visibility, null); assert.equal(removals, 2)
console.log('PASS isolated ProProvider: real 8s wait, login/logout/resume, duplicate/stale success/failure, retry/beta, abort/teardown')

// Actual search handler, controlled completion ordering (transport-isolated).
const searchStart = source.indexOf('  const searchRaces = async ')
const searchEnd = source.indexOf('  const updateRaceDraft = ', searchStart)
assert.ok(searchStart > 0 && searchEnd > searchStart)
const searchState = {}, searchRequests = []
let searchAuthCurrent = true
const searchBox = {
  raceQuery: 'older', searchRequest: { current: null }, AbortController,
  getAuthSession: () => ({ token: 'synthetic-search' }), isAuthSessionCurrent: () => searchAuthCurrent,
  api: { get: (_url, config) => new Promise((resolve,reject) => searchRequests.push({config,resolve,reject})) },
}
for (const field of ['RaceResults','RaceSearched','RaceSearchLoading','RaceSearchError']) searchBox[`set${field}`] = value => { searchState[field] = value }
vm.createContext(searchBox)
vm.runInContext(`${source.slice(searchStart,searchEnd)}; globalThis.search=searchRaces`, searchBox)
const submit = { preventDefault() {} }
const older = searchBox.search(submit)
assert.equal(searchState.RaceSearchLoading, true)
await searchBox.search(submit); assert.equal(searchRequests.length,1)
searchBox.raceQuery = 'newer'; const newer = searchBox.search(submit)
assert.equal(searchRequests[0].config.signal.aborted,true)
searchRequests[1].resolve({data:{races:[{id:'newer'}]}}); await newer
searchRequests[0].resolve({data:{races:[{id:'older'}]}}); await older
assert.equal(searchState.RaceResults[0].id,'newer')
const staleError = searchBox.search(submit)
searchBox.raceQuery='latest';const latest=searchBox.search(submit)
searchRequests[3].resolve({data:{races:[]}});await latest
searchRequests[2].reject(new Error('obsolete network error'));await staleError
assert.equal(searchState.RaceSearchError,'');assert.equal(searchState.RaceResults.length,0)
const errorSearch=searchBox.search(submit);searchRequests.at(-1).reject(new Error('network error'));await errorSearch
assert.match(searchState.RaceSearchError,/Try Search again/)
searchBox.raceQuery='x';await searchBox.search(submit)
assert.match(searchState.RaceSearchError,/at least two/);assert.equal(searchState.RaceSearchLoading,false)
searchBox.raceQuery='account changed';const staleAccount=searchBox.search(submit)
searchAuthCurrent=false
const beforeStale=JSON.stringify(searchState)
searchRequests.at(-1).resolve({data:{races:[{id:'foreign'}]}});await staleAccount
assert.equal(JSON.stringify(searchState),beforeStale)
console.log('PASS isolated search handler: loading/result/empty/error, explicit input, duplicate, stale success/failure/account fences')

// Execute actual validation before the free-user premium decision; no transport
// or generation is invoked in this validation-only fixture.
const generationStart=source.indexOf('  const generatePlan = async ')
const generationEnd=source.indexOf('\n  return (',generationStart)
assert.ok(generationStart>0&&generationEnd>generationStart)
let validationError='', gateCalls=0
const validation={ generationInFlight:{current:null},parsedGoalTime:undefined,weeks:'',selectedDistance:13.1,
  runDaysPerWeek:3,liftingEnabled:false,liftDaysPerWeek:0,isRacePlan:true,
  raceDraft:{name:'Arbitrary Sunrise Event',date:'2027-01-01'},trainingDays:['Tue','Thu','Sat'],liftEligibleWeekdays:[],
  localTodayISO:()=> '2026-11-02', isValidISODate: value=>/^\d{4}-\d{2}-\d{2}$/.test(value),
  setError: value=>{validationError=value}, ensurePro:()=>{gateCalls++;return false} }
vm.createContext(validation)
vm.runInContext(`${source.slice(generationStart,generationEnd)};globalThis.generate=generatePlan`,validation)
for (const distance of [NaN,Infinity,0,0.01,101]) {
  validation.selectedDistance=distance;await validation.generate();assert.match(validationError,/0.1 and 100/)
}
validation.selectedDistance=13.1;validation.raceDraft.name=' ';await validation.generate();assert.match(validationError,/race name/)
validation.raceDraft.name='Arbitrary Sunrise Event';validation.raceDraft.date='2026-11-01';await validation.generate();assert.match(validationError,/today or later/)
assert.equal(gateCalls,0,'invalid draft does not trigger upgrade')
validation.raceDraft.date='2027-01-01';await validation.generate();assert.equal(gateCalls,1);assert.equal(validationError,'')
console.log('PASS isolated manual validation: finite 0.1–100 miles, arbitrary name/date, valid free draft reaches premium gate')
