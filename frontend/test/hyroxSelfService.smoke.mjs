import assert from 'node:assert/strict'
import {
  hyroxCombinedPlanGuidance,
  hyroxDivisionLabel,
  hyroxSetupInitialState,
  isHyroxRace,
  preferredActiveSecondaryRaceId,
} from '../src/lib/hyroxSelfService.js'
import { buildWeekDays, parseLocalDate } from '../src/lib/planCalendar.js'

const hyrox = {
  id: 'hyrox-dc',
  race_name: 'HYROX Washington DC',
  race_date: '2026-09-06',
  event_local_date: '2026-09-06',
  event_timezone: 'America/New_York',
  event_kind: 'hyrox',
  event_format: 'doubles',
  event_category: 'men',
  location: 'Washington, DC',
  status: 'upcoming',
  event_config_json: JSON.stringify({
    equipment: ['ski_erg', 'sled_push', 'unsupported_machine'],
    runningPriority: 'maintain',
    runDaysPerWeek: 4,
    trainingDays: ['Mon', 'Wed', 'Fri', 'Sun'],
  }),
}

assert.equal(isHyroxRace(hyrox), true)
assert.equal(hyroxDivisionLabel(hyrox), 'Doubles Men', 'saved cards show both format and category')
assert.equal(hyroxDivisionLabel({ event_format: 'doubles' }), 'Division not set', 'partial divisions never render as an ambiguous format-only label')
assert.equal(hyroxDivisionLabel({ event_category: 'men' }), 'Division not set', 'partial divisions never render as an ambiguous category-only label')

const fresh = hyroxSetupInitialState(null, '', 'America/New_York')
assert.equal(fresh.eventFormat, '', 'new HYROX setup never silently defaults to Open')
assert.equal(fresh.eventCategory, '', 'new HYROX setup requires a category')

const existing = hyroxSetupInitialState(hyrox, 'army', 'UTC')
assert.equal(existing.eventFormat, 'doubles')
assert.equal(existing.eventCategory, 'men')
assert.equal(existing.eventLocalDate, '2026-09-06')
assert.equal(existing.eventTimezone, 'America/New_York')
assert.equal(existing.runDaysPerWeek, 4)
assert.deepEqual(existing.trainingDays, ['Mon', 'Wed', 'Fri', 'Sun'])
assert.deepEqual(existing.equipment, ['ski_erg', 'sled_push'], 'only supported HYROX equipment is restored')
assert.equal(existing.secondaryRaceId, 'army')
assert.equal(existing.ownedHyroxRace.id, 'hyrox-dc')

const yonkers = { id: 'yonkers', race_name: 'Yonkers Half Marathon', race_date: '2026-09-20', event_kind: 'run_race', status: 'upcoming' }
const army = { id: 'army', race_name: 'Army Ten-Miler', race_date: '2026-10-11', event_kind: 'run_race', status: 'upcoming' }
assert.equal(preferredActiveSecondaryRaceId({
  hyroxRace: hyrox,
  savedRaces: [hyrox, yonkers, army],
  activePlanRaceIds: ['yonkers', 'army'],
}), 'army', 'the valid post-HYROX active race is preselected while the 14-day collision is excluded')

assert.equal(preferredActiveSecondaryRaceId({
  hyroxRace: hyrox,
  savedRaces: [hyrox, yonkers],
  activePlanRaceIds: ['yonkers'],
}), '', 'no unsupported close race is guessed into the candidate')

const guidance = hyroxCombinedPlanGuidance({
  hyroxRace: hyrox,
  savedRaces: [hyrox, yonkers, army],
  activePlanRaceIds: ['yonkers', 'army'],
  selectedSecondaryRaceId: 'army',
})
assert.equal(guidance.selectedRace.id, 'army')
assert.equal(guidance.excludedActiveRaces.length, 1)
assert.equal(guidance.excludedActiveRaces[0].race.id, 'yonkers')
assert.equal(guidance.excludedActiveRaces[0].reasonCode, 'race_spacing_conflict')
assert.match(guidance.excludedActiveRaces[0].explanation, /Yonkers Half Marathon.*14 days.*at least 21 days.*change either event date/i)

const laterRace = { id: 'fall-half', race_name: 'Fall Half', race_date: '2026-10-25', event_kind: 'run_race', status: 'upcoming' }
const oneSecondaryOnly = hyroxCombinedPlanGuidance({
  hyroxRace: hyrox,
  savedRaces: [hyrox, army, laterRace],
  activePlanRaceIds: ['army', 'fall-half'],
  selectedSecondaryRaceId: 'army',
})
assert.equal(oneSecondaryOnly.excludedActiveRaces[0].reasonCode, 'one_secondary_limit')
assert.match(oneSecondaryOnly.excludedActiveRaces[0].explanation, /Fall Half.*only one secondary running race.*choose which/i)

const recoveryWeek = {
  days: [{ date: '2026-07-13', day: 'Mon', sessions: [{
    id: 'rest-or-walk',
    removal_session_id: 'rest-or-walk',
    kind: 'rest',
    type: 'rest',
    title: 'Rest, easy walking, or mobility',
    recovery_alternative: {
      policy: 'minimum_effective_recovery_session_v1',
      minimum_run_minutes: 20,
      minimum_run_miles: 1.5,
      reduced_run_minutes: 11,
      reduced_run_miles: 0.8,
      activity_health_minimum_claimed: false,
      safety_rationale: 'A token run would not provide the intended recovery session.',
      options: [
        { type: 'rest', duration_minutes: 0, intensity: 'Rest / no exercise', safety_rationale: 'Choose rest when tired, sore, or unwell.' },
        { type: 'walking', duration_range_minutes: [20, 30], intensity: 'Very easy and conversational', safety_rationale: 'Stop if movement is not comfortable.' },
        { type: 'mobility', duration_range_minutes: [5, 10], intensity: 'Gentle, comfortable range', safety_rationale: 'Avoid painful ranges.' },
      ],
    },
  }] }],
}
const recoveryDays = buildWeekDays(recoveryWeek, parseLocalDate('2026-07-13'), { runOnly: true })
assert.equal(recoveryDays[0].isRest, true)
assert.equal(recoveryDays[0].sessions.length, 0, 'the alternative is not exposed as an executable run')
assert.equal(recoveryDays[0].restPrescription.title, 'Rest, easy walking, or mobility')
assert.deepEqual(recoveryDays[0].restPrescription.raw.recovery_alternative.options.map((option) => option.type), ['rest', 'walking', 'mobility'])
const removedRecoveryDays = buildWeekDays(recoveryWeek, parseLocalDate('2026-07-13'), {
  runOnly: true,
  removedSessionIds: new Set(['rest-or-walk']),
})
assert.equal(removedRecoveryDays[0].restPrescription, null, 'removed rest prescriptions do not reappear in the calendar')

console.log('HYROX SELF-SERVICE AND RECOVERY PRESENTATION SMOKE OK')
