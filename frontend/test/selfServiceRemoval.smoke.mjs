import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  SELF_SERVICE_REMOVAL_TIMEOUT_MS,
  removeOwnedRace,
  removeScheduledWorkout,
} from '../src/lib/selfServiceRemoval.js'

const planSource = fs.readFileSync(new URL('../src/pages/Plan.jsx', import.meta.url), 'utf8')
const dayViewSource = fs.readFileSync(new URL('../src/components/calendar/ForgedDayView.jsx', import.meta.url), 'utf8')
const racesSource = fs.readFileSync(new URL('../src/pages/Races.jsx', import.meta.url), 'utf8')
const serviceWorkerSource = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')

const clock = { planning_date_local: '2026-08-12', timezone_offset_minutes: 240 }

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
assert.match(serviceWorkerSource, /isReplayUnsafeMutation/)
assert.match(serviceWorkerSource, /removal-\(\?:preview\|apply\)/)
assert.match(serviceWorkerSource, /adaptation\\\/\[\^\/\]\+\\\/\(\?:accept\|keep\)/)

console.log('SELF-SERVICE REMOVAL FRONTEND SMOKE OK')
