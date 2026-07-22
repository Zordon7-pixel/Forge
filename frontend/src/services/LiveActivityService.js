import { Capacitor, registerPlugin } from '@capacitor/core'

const ForgeLiveActivity = registerPlugin('ForgeLiveActivity')

function isNativeRuntime() {
  return Boolean(Capacitor?.isNativePlatform?.())
}

function isPluginAvailable() {
  return isNativeRuntime() && Capacitor.isPluginAvailable('ForgeLiveActivity')
}

async function failSoft(action, callback, fallback) {
  if (!isPluginAvailable()) return fallback
  try {
    return await callback()
  } catch (error) {
    console.warn(`[LiveActivity] ${action} failed:`, error?.message || error)
    return fallback
  }
}

const LiveActivityService = {
  isPluginAvailable,

  async isAvailable() {
    return failSoft('availability check', async () => {
      const result = await ForgeLiveActivity.isAvailable()
      return Boolean(result?.available)
    }, false)
  },

  async currentActivityId() {
    return failSoft('current activity lookup', async () => {
      const result = await ForgeLiveActivity.currentActivityId()
      return String(result?.activityId || '') || null
    }, null)
  },

  async start(attributes, content) {
    return failSoft('start', async () => {
      const result = await ForgeLiveActivity.start({ attributes, content })
      return String(result?.activityId || '') || null
    }, null)
  },

  async update(content) {
    return failSoft('update', async () => {
      const result = await ForgeLiveActivity.update({ content })
      return Boolean(result?.updated)
    }, false)
  },

  async end() {
    return failSoft('end', async () => {
      const result = await ForgeLiveActivity.end()
      return Boolean(result?.ended)
    }, false)
  },
}

export default LiveActivityService
