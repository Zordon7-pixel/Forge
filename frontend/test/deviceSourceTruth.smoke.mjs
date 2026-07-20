import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatFreshness,
  GARMIN_BETA_PRESENTATION,
  hrZoneSourcePresentation,
  providerSourcePresentation,
} from '../src/lib/deviceSourcePresentation.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
const settings = read('frontend/src/pages/Settings.jsx')
const hrZones = read('frontend/src/pages/HrZones.jsx')

let passed = 0
function check(condition, message) {
  assert.ok(condition, message)
  passed += 1
}

check(GARMIN_BETA_PRESENTATION.state === 'direct_unavailable' && GARMIN_BETA_PRESENTATION.canConnect === false, 'default beta Garmin state is unavailable and has no Connect action')
check(GARMIN_BETA_PRESENTATION.detail === 'Direct Garmin connection is unavailable in this beta. Garmin workouts may enter Forge through Apple Health when Garmin Connect writes them there.', 'default beta Garmin copy explains only the truthful Apple Health path')
check(settings.includes('{GARMIN_BETA_PRESENTATION.detail}') && !settings.includes("api.get('/garmin/status')") && !settings.includes('handleGarminDisconnect'), 'Settings renders the beta presentation without a legacy connection state or action')

const appleHealth = providerSourcePresentation({ source: 'apple_health', deviceOwner: 'Garmin owner', deviceName: 'Garmin Forerunner' })
check(appleHealth.kind === 'apple_health' && appleHealth.label === 'Apple Health', 'Apple Health stays Apple Health when Garmin appears only in unrelated ownership metadata')
const garminViaApple = providerSourcePresentation({ source: 'apple_health', upstreamProvider: 'garmin_connect' })
check(garminViaApple.kind === 'garmin_via_apple_health' && garminViaApple.label === 'Garmin via Apple Health', 'Garmin via Apple Health requires explicit upstream-provider evidence')

check(providerSourcePresentation('strava').label === 'Strava' && providerSourcePresentation('strava_csv').kind === 'strava', 'Strava sync and file sources render as Strava')
check(providerSourcePresentation('forge').label === 'Forge' && providerSourcePresentation('manual_json').label === 'Forge / manual', 'Forge and manual activity sources render correctly')

const unknown = providerSourcePresentation('favorite_garmin_watch')
check(unknown.kind === 'unavailable' && unknown.label === 'Source unavailable' && !unknown.label.includes('Garmin'), 'unknown source fails closed to neutral copy')

check(formatFreshness(null) === null && formatFreshness('') === null && formatFreshness('not-a-date') === null, 'missing or invalid timestamps do not fabricate freshness')
check(formatFreshness('2026-07-20T15:04:00.000Z') === 'Last synced Jul 20, 2026, 3:04 PM UTC', 'valid sync timestamp formats deterministically')
check(formatFreshness('2026-07-20T15:04:00.000Z', { prefix: 'Updated' }) === 'Updated Jul 20, 2026, 3:04 PM UTC', 'valid update timestamp formats deterministically')

const manualHrr = hrZoneSourcePresentation({ source: 'manual', zoneModel: 'hrr', maxHr: 190, restingHr: 52 })
check(manualHrr.label === 'Manual profile' && manualHrr.detail === 'Calculated from your saved max and resting heart rates.', 'HR-zone manual source describes only the stored fields used by the model')
const fieldTest = hrZoneSourcePresentation({ source: 'field_test', zoneModel: 'lthr', lthr: 171 })
check(fieldTest.label === 'Field test' && /lactate-threshold/.test(fieldTest.detail), 'HR-zone field-test source matches the stored LTHR field')
const unknownHr = hrZoneSourcePresentation({ source: null, zoneModel: 'maxhr', maxHr: 190 })
check(unknownHr.label === 'Source unavailable' && unknownHr.detail === 'Calculated from your saved max heart rate.', 'HR-zone unknown provenance stays neutral while describing available derivation fields')
check(hrZones.includes('hrZoneSourcePresentation(profile || {})') && hrZones.includes("formatFreshness(profile?.updatedAt, { prefix: 'Updated' })"), 'HR Zones consumes existing source and updated metadata')

const garminSurfaceCount = (settings.match(/data-device-provider="garmin"/g) || []).length
check(garminSurfaceCount === 1, 'Settings contains exactly one structural Garmin surface')
check(settings.includes(".filter((provider) => provider.id !== 'garmin')"), 'Watch Delivery cannot add a second Garmin row')
check(!settings.includes('Status: Not connected') && !settings.includes('Garmin sync is paused'), 'legacy contradictory Garmin status copy is absent')

console.log(`DEVICE & SOURCE TRUTH SMOKE OK (${passed})`)
