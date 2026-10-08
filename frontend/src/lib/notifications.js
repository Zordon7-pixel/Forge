import api from './api'
import { createPushSetupCoordinator } from './pushSetup.js'

export function canUseWebPush() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

// Configuration is not claim authority. Mutations use the dedicated never-queued surface.
export function createNotificationSetup(onChange) {
  return createPushSetupCoordinator({
    onChange,
    readConfig: async (session) => {
      const { data } = await api.get('/notifications/push/config', { forgeAuthSession: session })
      return data
    },
  })
}
