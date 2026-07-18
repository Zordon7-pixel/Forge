import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(root, '..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')

const settings = read('frontend/src/pages/Settings.jsx')
const strava = read('backend/src/routes/strava.js')
const oura = read('backend/src/routes/oura.js')

let passed = 0
function check(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

check(settings.includes("import { App as CapacitorApp } from '@capacitor/app'"), 'Settings listens to native app lifecycle events')
check(settings.includes("CapacitorApp.addListener('appStateChange'") && settings.includes("CapacitorApp.addListener('resume'"), 'provider status refreshes when the native shell resumes')
check(settings.includes("params: { fresh: Date.now() }"), 'provider status requests bypass stale browser caches')
check(settings.includes('startDeviceConnectionPoll(device)'), 'OAuth launch starts a bounded connection-status poll')
check(settings.includes('attempts >= 60'), 'connection polling is bounded')
check(settings.includes('aria-label="Refresh device status"') && settings.includes('handleDeviceStatusRefresh'), 'Devices exposes a manual status refresh after OAuth return')
check(!settings.includes("api.get('/strava/status').catch(() => ({ data: { connected: false } }))"), 'status errors are not silently rendered as disconnected')
check(settings.includes('available: false, statusChecked: true, statusUnavailable: true'), 'provider status failures keep Connect disabled')
check(settings.includes("overflowWrap: 'anywhere'") && !settings.includes("textTransform: 'uppercase', whiteSpace: 'nowrap'"), 'provider labels wrap at narrow and pinch-zoom widths')
check(strava.includes("res.set('Cache-Control', 'no-store')"), 'Strava status is never cached')
check(oura.includes("res.set('Cache-Control', 'no-store')"), 'Oura status is never cached')
check(strava.includes('available: getMissingStravaEnv().length === 0'), 'Strava reports whether provider credentials are configured')
check(oura.includes('available: getMissingEnv().length === 0'), 'Oura reports whether provider credentials are configured')
check(oura.includes("scope: 'daily personal heartrate'"), 'Oura requests only valid v2 scopes used by the current sync')
check(oura.includes("ouraApiFetch(tokens.access_token, '/personal_info')"), 'Oura personal-info call resolves against the v2 usercollection base')
check(strava.includes("title: 'Strava Connected'") && oura.includes("title: 'Oura Connected'"), 'both OAuth callbacks render a completion page')

console.log(`DEVICE CONNECTIONS SMOKE OK (${passed})`)
