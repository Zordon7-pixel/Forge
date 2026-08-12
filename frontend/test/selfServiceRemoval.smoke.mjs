import assert from 'node:assert/strict'
import fs from 'node:fs'
import { removeOwnedRace, removeScheduledWorkout } from '../src/lib/selfServiceRemoval.js'

const planSource = fs.readFileSync(new URL('../src/pages/Plan.jsx', import.meta.url), 'utf8')
const dayViewSource = fs.readFileSync(new URL('../src/components/calendar/ForgedDayView.jsx', import.meta.url), 'utf8')

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
  const calls = []
  const api = {
    async post(path, body) {
      calls.push({ method: 'post', path, body })
      if (path.endsWith('/removal-preview')) {
        return { data: { requires_apply: true, candidate_id: 'candidate-1', candidate_hash: 'sha256:owned' } }
      }
      return { data: { ok: true } }
    },
    async delete() { throw new Error('linked removal must not call direct delete') },
  }
  const result = await removeOwnedRace({ api, raceId: 'linked-race', planningClock: clock })
  assert.equal(result.path, 'linked')
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
  const api = {
    async delete(path) {
      calls.push(path)
      return { data: { ok: true, removedSessionIds: ['lift-1'] } }
    },
  }
  const result = await removeScheduledWorkout({ api, sessionId: 'lift / 1' })
  assert.deepEqual(calls, ['/plans/my/sessions/lift%20%2F%201'])
  assert.deepEqual(result.removedSessionIds, ['lift-1'])
}

assert.match(planSource, /window\.confirm\(`Remove \$\{label\} from this training plan\? Recorded workouts and health history will stay intact\.`\)/)
assert.match(planSource, /allowSessionRemoval=\{selectedDay\.dateISO >= today\}/)
assert.match(planSource, /progress: \{ \.\.\.\(current\.progress \|\| \{\}\), removedSessionIds \}/)
assert.match(planSource, /Could not remove \$\{label\}\. The plan is unchanged\./)
assert.match(dayViewSource, /aria-label=\{`Remove \$\{session\.title \|\| 'workout'\} from this plan`\}/)
assert.match(dayViewSource, /minHeight: 44/)
assert.match(dayViewSource, /role="alert"/)
assert.match(dayViewSource, /role="status" aria-live="polite"/)

console.log('SELF-SERVICE REMOVAL FRONTEND SMOKE OK')
