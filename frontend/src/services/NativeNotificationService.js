import { Capacitor, registerPlugin } from '@capacitor/core'

const ForgeNotification = registerPlugin('ForgeNotification')
const SAFE_PATH = /^\/(?:history|more|run\/recap\/[A-Za-z0-9_-]{1,220})(?:\?[^#]{0,300})?$/

function isAvailable() {
  return Boolean(Capacitor?.isNativePlatform?.() && Capacitor.isPluginAvailable('ForgeNotification'))
}

function normalizePayload(value = {}) {
  if (!value || typeof value !== 'object') return null
  const path = SAFE_PATH.test(String(value.path || '')) ? String(value.path) : '/history'
  const source = String(value.source || '').trim().slice(0, 40)
  const sourceWorkoutId = String(value.sourceWorkoutId || '').trim().slice(0, 200)
  const notificationId = String(value.notificationId || '').trim().slice(0, 220)
  if (!source && !sourceWorkoutId && !notificationId && path === '/history' && !value.path) return null
  return { path, source, sourceWorkoutId, notificationId }
}

const NativeNotificationService = {
  isAvailable,

  async consumePendingNavigation() {
    if (!isAvailable()) return null
    try {
      return normalizePayload(await ForgeNotification.consumePendingNavigation())
    } catch (error) {
      console.warn('[NativeNotification] pending navigation unavailable:', error?.message || error)
      return null
    }
  },

  async addNavigationListener(callback) {
    if (!isAvailable()) return null
    return ForgeNotification.addListener('notificationNavigation', (payload) => {
      const normalized = normalizePayload(payload)
      if (normalized) callback(normalized)
    })
  },
}

export default NativeNotificationService
