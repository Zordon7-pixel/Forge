import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  ACTIVE_PLAN_DELETE_CONFIRMATION,
  PLAN_RESET_CONFIRMATION,
  SELF_SERVICE_REMOVAL_TIMEOUT_MS,
  deleteActivePlan,
  removeOwnedRace,
  removeScheduledWorkout,
  resetOwnedRace,
} from '../src/lib/selfServiceRemoval.js'
import { verifyRaceRemovalActivation } from '../src/lib/planActivation.js'

const planSource = fs.readFileSync(new URL('../src/pages/Plan.jsx', import.meta.url), 'utf8')
const dayViewSource = fs.readFileSync(new URL('../src/components/calendar/ForgedDayView.jsx', import.meta.url), 'utf8')
const racesSource = fs.readFileSync(new URL('../src/pages/Races.jsx', import.meta.url), 'utf8')
const serviceWorkerSource = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
const planResetEffectSource = racesSource.match(
  /useEffect\(\(\) => \{\s*if \(!planResetRace\)[\s\S]*?\}, \[planResetRace\]\)/,
)?.[0] || ''
const planResetCatchSource = racesSource.match(
  /if \(err\?\.code === 'PLAN_RESET_REQUIRED'\) \{([\s\S]*?)\n\s*\}/,
)?.[1] || ''
const planResetDialogSource = racesSource.match(
  /\{planResetRace && \(\s*(<section[\s\S]*?<\/section>)\s*\)\}/,
)?.[1] || ''
const keepEverythingHandlerSource = planResetDialogSource.match(
  /onClick=\{\(\) => \{([\s\S]*?)\}\}[\s\S]*?>Keep everything<\/button>/,
)?.[1] || ''

const clock = { planning_date_local: '2026-08-12', timezone_offset_minutes: 240 }

function responseError(status, code, message = 'Request failed') {
  return Object.assign(new Error(message), {
    response: { status, data: { code, error: message } },
  })
}

{
  const calls = []
  const api = {
    async delete(path, config) {
      calls.push({ path, config })
      return { data: { active_plan_deleted: true, history_preserved: true, saved_races_preserved: true } }
    },
  }
  const result = await deleteActivePlan({ api })
  assert.equal(ACTIVE_PLAN_DELETE_CONFIRMATION, 'DELETE_ACTIVE_PLAN')
  assert.equal(result.active_plan_deleted, true)
  assert.equal(calls[0].path, '/plans/my')
  assert.deepEqual(calls[0].config.data, { confirmation: 'DELETE_ACTIVE_PLAN' })
  assert.ok(Number(calls[0].config.timeout) > 0, 'plan deletion has a bounded request deadline')
}

{
  const api = {
    async post() { throw responseError(409, 'GOAL_BACKWARD_GENERATION_FAILED') },
  }
  await assert.rejects(
    () => removeOwnedRace({ api, raceId: 'invalid-plan-race', planningClock: clock }),
    (error) => error?.code === 'PLAN_RESET_REQUIRED'
      && /current plan cannot be rebuilt safely/i.test(error.message)
      && !error.message.includes('GOAL_BACKWARD_GENERATION_FAILED'),
    'the proven invalid-plan preview deadlock becomes a typed, human-readable reset requirement',
  )
}

{
  const api = {
    async post() { return { data: { requires_apply: false } } },
    async delete() { throw responseError(409, 'ACTIVE_PLAN_LINKAGE_UNVERIFIED') },
  }
  await assert.rejects(
    () => removeOwnedRace({ api, raceId: 'legacy-plan-race', planningClock: clock }),
    (error) => error?.code === 'PLAN_RESET_REQUIRED',
    'the proven direct-delete linkage deadlock becomes reset-required',
  )
}

for (const [label, error] of [
  ['authentication failure', responseError(401, 'GOAL_BACKWARD_GENERATION_FAILED')],
  ['validation failure', responseError(400, 'ACTIVE_PLAN_LINKAGE_UNVERIFIED')],
  ['ordinary conflict', responseError(409, 'ACTIVE_PLAN_REBUILD_REQUIRED')],
  ['network failure', Object.assign(new Error('offline'), { code: 'ENETDOWN' })],
]) {
  const api = { async post() { throw error } }
  await assert.rejects(
    () => removeOwnedRace({ api, raceId: 'ordinary-failure', planningClock: clock }),
    (received) => received?.code !== 'PLAN_RESET_REQUIRED',
    `${label} cannot trigger the destructive reset fallback`,
  )
}

{
  const calls = []
  const api = {
    async post(path, body) {
      calls.push({ path, body })
      return { data: { ok: true } }
    },
  }
  const result = await resetOwnedRace({ api, raceId: 'race / owned' })
  assert.equal(result.ok, true)
  assert.equal(PLAN_RESET_CONFIRMATION, 'CLEAR_ACTIVE_PLAN_AND_REMOVE_RACE')
  assert.deepEqual(calls, [{
    path: '/races/race%20%2F%20owned/removal-reset',
    body: { confirmation: 'CLEAR_ACTIVE_PLAN_AND_REMOVE_RACE' },
  }], 'the explicit reset sends only the exact confirmation literal to the encoded owned-race route')
}

assert.equal(verifyRaceRemovalActivation({
  races: [{ id: 'army' }],
  activePlan: null,
  activePlanReadConfirmed: true,
  removedRaceId: 'yonkers',
  resetMode: true,
}).confirmed, true, 'reset verification requires an authoritative empty active-plan read')
assert.equal(verifyRaceRemovalActivation({
  races: [{ id: 'army' }],
  activePlan: { plan_data: { goals: [{ raceId: 'army' }] } },
  activePlanReadConfirmed: true,
  removedRaceId: 'yonkers',
  resetMode: true,
}).confirmed, false, 'reset verification rejects any surviving active plan, even when the removed goal is absent')

{
  const calls = []
  const api = {
    async post(path, body) {
      calls.push({ method: 'post', path, body })
      return { data: { requires_apply: false } }
    },
    async delete(path) {
      calls.push({ method: 'delete', path })
      return { data: { ok: true } }
    },
  }
  const result = await removeOwnedRace({ api, raceId: 'race / owned', planningClock: clock })
  assert.equal(result.path, 'direct')
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [
    ['post', '/races/race%20%2F%20owned/removal-preview'],
    ['delete', '/races/race%20%2F%20owned'],
  ])
}

{
  let directDeleteCalled = false
  const api = {
    async post() { return { data: { queued: true, offline: true } } },
    async delete() { directDeleteCalled = true; return { data: { ok: true } } },
  }
  await assert.rejects(
    () => removeOwnedRace({ api, raceId: 'offline-race', planningClock: clock }),
    (error) => error?.code === 'REMOVAL_OFFLINE' && /live connection/i.test(error.message),
  )
  assert.equal(directDeleteCalled, false, 'an offline preview response cannot fall through to destructive direct removal')
}

{
  const api = { post: async () => new Promise(() => {}) }
  const startedAt = Date.now()
  await assert.rejects(
    () => removeOwnedRace({ api, raceId: 'slow-race', planningClock: clock, timeoutMs: 10 }),
    (error) => error?.code === 'REMOVAL_TIMEOUT' && /stopped waiting/i.test(error.message),
  )
  assert.ok(Date.now() - startedAt < 1000, 'a hung race-removal request releases the UI deadline')
}

{
  const calls = []
  const api = {
    async post(path, body) {
      calls.push({ method: 'post', path, body })
      if (path.endsWith('/removal-preview')) {
        return { data: {
          requires_apply: true,
          candidate_id: 'candidate-1',
          candidate_hash: 'sha256:owned',
          removal: { remaining_race_ids: ['army'] },
          apply_bindings: {
            candidate_id: 'candidate-replay',
            candidate_hash: 'sha256:replay',
            choice: 'keep_current',
            planning_date_local: '1999-12-31',
            timezone_offset_minutes: -720,
            candidate_revision: 1,
            decision_id: 'decision-1',
          },
        } }
      }
      return { data: { ok: true } }
    },
    async delete() { throw new Error('linked removal must not call direct delete') },
  }
  const result = await removeOwnedRace({ api, raceId: 'linked-race', planningClock: clock })
  assert.equal(result.path, 'linked')
  assert.deepEqual(result.expectedRemainingRaceIds, ['army'])
  assert.equal(calls[1].path, '/races/linked-race/removal-apply')
  assert.deepEqual(calls[1].body, {
    candidate_id: 'candidate-1',
    candidate_hash: 'sha256:owned',
    choice: 'train_for_target',
    ...clock,
    candidate_revision: 1,
    decision_id: 'decision-1',
  })
  assert.equal(calls.some((call) => call.path.includes('/plans/candidates/')), false)
}

{
  const api = {
    async post(path) {
      if (path.endsWith('/removal-preview')) return { data: {
        requires_apply: true,
        candidate_id: 'candidate-replay',
        candidate_hash: 'sha256:replay',
        removal: { remaining_race_ids: ['army'] },
      } }
      const error = new Error('ambiguous apply response')
      error.code = 'ETIMEDOUT'
      throw error
    },
  }
  await assert.rejects(
    () => removeOwnedRace({ api, raceId: 'linked-race', planningClock: clock }),
    (error) => error?.code === 'REMOVAL_TIMEOUT'
      && JSON.stringify(error.expectedRemainingRaceIds) === JSON.stringify(['army']),
    'an ambiguous apply preserves the exact remaining-goal expectation for authoritative refetch',
  )
}

assert.equal(SELF_SERVICE_REMOVAL_TIMEOUT_MS, 45000)

{
  const api = {
    async post() { return { data: { requires_apply: true } } },
    async delete() { throw new Error('must not delete without apply token') },
  }
  await assert.rejects(
    () => removeOwnedRace({ api, raceId: 'linked-race', planningClock: clock }),
    /missing its apply token/,
  )
}

{
  const calls = []
  const removalSessionId = 'remove:v1:2026-08-13:id%3Alift-1'
  const api = {
    async delete(path) {
      calls.push(path)
      return { data: { ok: true, removedSessionIds: [removalSessionId] } }
    },
  }
  const result = await removeScheduledWorkout({ api, sessionId: removalSessionId })
  assert.deepEqual(calls, ['/plans/my/sessions/remove%3Av1%3A2026-08-13%3Aid%253Alift-1'])
  assert.deepEqual(result.removedSessionIds, [removalSessionId])
}

assert.match(planSource, /window\.confirm\(`Remove \$\{label\} from this training plan\? Recorded workouts and health history will stay intact\.`\)/)
assert.match(planSource, /window\.confirm\(`Delete \$\{planName\}\? The training calendar will be removed\. Completed workouts, health data, and saved races will stay\.`\)/)
assert.match(planSource, /deleteActivePlan\(\{ api \}\)/)
assert.match(planSource, /refreshed && !refreshed\.plan/)
const calendarSource = fs.readFileSync(new URL('../src/components/calendar/ForgedCalendar.jsx', import.meta.url), 'utf8')
const calendarStyles = fs.readFileSync(new URL('../src/components/calendar/forgedCalendar.css', import.meta.url), 'utf8')
assert.match(calendarSource, /className="forged-plan-delete"/)
assert.match(calendarSource, /aria-label=\{`Delete \$\{planName \|\| goal\.name \|\| 'training plan'\}`\}/)
assert.match(calendarStyles, /\.forged-plan-delete[\s\S]*position:\s*absolute;[\s\S]*right:\s*12px;[\s\S]*top:\s*12px;[\s\S]*width:\s*44px;/)
assert.match(planSource, /const removalSessionId = String\(session\?\.removalSessionId \|\| ''\)/)
assert.match(planSource, /removeScheduledWorkout\(\{ api, sessionId: removalSessionId \}\)/)
assert.doesNotMatch(planSource, /removeScheduledWorkout\(\{ api, sessionId: session\.id \}\)/)
assert.match(planSource, /allowSessionRemoval=\{selectedDay\.dateISO >= today\}/)
assert.match(planSource, /confirmedIds\.includes\(removalSessionId\)/)
assert.match(dayViewSource, /aria-label=\{`Remove \$\{session\.title \|\| 'workout'\} from this plan`\}/)
assert.match(dayViewSource, /!session\?\.removalSessionId/)
assert.match(dayViewSource, /const isDone = \(session\) => sessionState\(session, completedSet\) === 'completed'/)
assert.match(dayViewSource, /if \(!allowSessionRemoval \|\| done \|\|/)
assert.match(dayViewSource, /minHeight: 44/)
assert.match(dayViewSource, /role="alert"/)
assert.match(dayViewSource, /role="status" aria-live="polite"/)
assert.match(planSource, /Forge did not confirm the workout removal after refreshing the plan/)
assert.match(planSource, /Forge confirmed it after refreshing your account/)
assert.match(planSource, /\['ADAPTATION_STALE', 'ADAPTATION_PROPOSAL_CHANGED', 'ADAPTATION_DECISION_TOKEN_REQUIRED'\]\.includes\(errorData\.code\)/)
assert.match(planSource, /proposal_revision: adaptationProposal\.revision/)
assert.match(planSource, /proposal_plan_version: adaptationProposal\.planVersion/)
assert.match(planSource, /Review the updated proposal before accepting it/)
assert.match(racesSource, /await load\(\{ fresh: true \}\)/)
assert.match(racesSource, /The race is still listed/)
assert.match(racesSource, /active plan goals are not confirmed/)
assert.match(racesSource, /Forge confirmed it after refreshing your account/)
assert.match(racesSource, /current active plan will be removed/i)
assert.match(racesSource, /Recorded runs, lifts, health data, check-ins, and training history (?:will remain|were preserved)/)
assert.match(racesSource, />Clear plan & remove race</)
assert.match(racesSource, />Keep everything</)
assert.match(racesSource, /err\?\.code === 'PLAN_RESET_REQUIRED'/)
assert.match(planResetEffectSource, /requestAnimationFrame/, 'reset-required schedules one post-render dialog reveal')
assert.equal((planResetEffectSource.match(/requestAnimationFrame/g) || []).length, 1, 'reset-required schedules exactly one reveal frame')
assert.match(planResetEffectSource, /planResetDialogRef\.current/, 'the reveal targets the rendered alertdialog ref')
assert.match(planResetEffectSource, /scrollIntoView[\s\S]*\.focus\(\{ preventScroll: true \}\)/, 'the reset confirmation is revealed before focus moves without a second scroll')
assert.match(planResetEffectSource, /cancelAnimationFrame/, 'closing before the frame runs safely cancels the reveal')
assert.doesNotMatch(planResetEffectSource, /confirmPlanResetRemoval|resetOwnedRace|\.click\(/, 'reveal and focus cannot trigger a destructive handler')
assert.match(planResetDialogSource, /role="alertdialog"/)
assert.match(planResetDialogSource, /ref=\{planResetDialogRef\}/, 'the actual alertdialog owns the reveal ref')
assert.match(planResetDialogSource, /tabIndex=\{-1\}/, 'the alertdialog surface is programmatically focusable')
assert.match(planResetDialogSource, /className="flex flex-wrap gap-2"/, 'confirmation actions wrap at compact phone widths')
assert.equal((planResetDialogSource.match(/minHeight: 44/g) || []).length, 2, 'both confirmation actions retain 44px minimum targets')
assert.match(keepEverythingHandlerSource, /setPlanResetRace\(null\)/)
assert.doesNotMatch(keepEverythingHandlerSource, /resetOwnedRace|confirmPlanResetRemoval|api\.(?:post|delete)|\.click\(/, 'Keep everything sends zero reset calls')
assert.doesNotMatch(planResetCatchSource, /setMessage\(/, 'reset-required does not write a duplicate status near the form')
assert.doesNotMatch(racesSource, /Forge could not safely rebuild the current plan\. Choose whether to keep everything or clear the plan and remove this race\./, 'the alertdialog is the only reset-required explanation')
assert.doesNotMatch(racesSource, />[^<]*(?:GOAL_BACKWARD_GENERATION_FAILED|ACTIVE_PLAN_LINKAGE_UNVERIFIED)[^<]*</)
assert.match(serviceWorkerSource, /isReplayUnsafeMutation/)
assert.match(serviceWorkerSource, /removal-\(\?:preview\|apply\|reset\)/)
assert.match(serviceWorkerSource, /adaptation\\\/\[\^\/\]\+\\\/\(\?:accept\|keep\)/)

console.log('SELF-SERVICE REMOVAL FRONTEND SMOKE OK')
