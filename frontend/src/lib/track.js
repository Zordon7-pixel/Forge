import api from './api'
import { getToken } from './tokenStore'

const APP_OPEN_KEY = 'forge_track_app_open_native_v1'

const ALLOWED_EVENTS = new Set([
  'app_open',
  'checkin',
  'run_logged',
  'lift_logged',
  'today_card_viewed',
  'recommendation_followed',
  'whats_new_shown',
  'whats_new_opened',
  'whats_new_cta',
])

export async function track(eventName, props) {
  try {
    if (!getToken()) return
    if (!ALLOWED_EVENTS.has(eventName)) return

    if (eventName === 'app_open') {
      if (sessionStorage.getItem(APP_OPEN_KEY) === '1') return
      sessionStorage.setItem(APP_OPEN_KEY, '1')
    }

    await api.post('/events', { event_name: eventName, props })
  } catch (err) {
    console.debug('track fail-soft:', err?.message)
  }
}

export default track
