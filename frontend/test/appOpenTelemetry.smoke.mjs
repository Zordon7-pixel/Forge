import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  FORGED_IOS_APP_ID,
  buildNativeIosAppOpenProps,
  emitAppOpenTelemetry,
} from '../src/lib/appOpenTelemetry.js'

const validInfo = { id: FORGED_IOS_APP_ID, version: '1.0.5', build: '19' }
assert.deepEqual(buildNativeIosAppOpenProps(validInfo, 240), {
  app_id: FORGED_IOS_APP_ID,
  app_version: '1.0.5',
  build_number: 19,
  native_runtime: true,
  platform: 'ios_native',
  timezone_offset_minutes: 240,
})
assert.equal(buildNativeIosAppOpenProps(validInfo, '0').timezone_offset_minutes, 0)
assert.equal(buildNativeIosAppOpenProps(validInfo, 0).timezone_offset_minutes, 0)
for (const malformedOffset of ['   ', '\t', false, [], {}]) {
  assert.throws(
    () => buildNativeIosAppOpenProps(validInfo, malformedOffset),
    /identity is incomplete/,
  )
}
assert.throws(
  () => buildNativeIosAppOpenProps({ ...validInfo, id: 'com.example.other' }, 240),
  /identity is incomplete/,
)

const tracked = []
await emitAppOpenTelemetry({
  capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
  capacitorApp: { getInfo: async () => validInfo },
  now: { getTimezoneOffset: () => 240 },
  track: async (...args) => tracked.push(args),
})
assert.deepEqual(tracked, [['app_open', {
  app_id: FORGED_IOS_APP_ID,
  app_version: '1.0.5',
  build_number: 19,
  native_runtime: true,
  platform: 'ios_native',
  timezone_offset_minutes: 240,
}]])

const webTracked = []
await emitAppOpenTelemetry({
  capacitor: { isNativePlatform: () => false },
  capacitorApp: { getInfo: async () => { throw new Error('must not run') } },
  track: async (...args) => webTracked.push(args),
})
assert.deepEqual(webTracked, [['app_open', { native_runtime: false, platform: 'web' }]])

const appSource = fs.readFileSync(
  fileURLToPath(new URL('../src/App.jsx', import.meta.url)),
  'utf8',
)
assert.match(appSource, /if \(sentRef\.current \|\| !isLoggedIn\(\)\) return undefined/)
assert.match(appSource, /emitAppOpenTelemetry\(\{ capacitor: Capacitor, capacitorApp: CapacitorApp, track \}\)/)
assert.match(appSource, /\}, \[location\.pathname\]\)/, 'app-open telemetry retries after a signed-out route transitions into the app')

console.log('APP OPEN TELEMETRY SMOKE OK')
