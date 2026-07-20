import api from './api'

function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)))
}

export function canUseWebPush() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
}

export async function getPushStatus() {
  if (!canUseWebPush()) return { supported: false, configured: false, subscribed: false, permission: 'unsupported' }
  const [{ data }, registration] = await Promise.all([
    api.get('/notifications/push/config'),
    navigator.serviceWorker.ready,
  ])
  const subscription = await registration.pushManager.getSubscription()
  return {
    supported: true,
    configured: Boolean(data?.configured && data?.publicKey),
    subscribed: Boolean(subscription),
    permission: Notification.permission,
  }
}

export async function enablePushNotifications() {
  if (!canUseWebPush()) throw new Error('Push notifications are not supported in this app view.')
  const { data } = await api.get('/notifications/push/config')
  if (!data?.configured || !data?.publicKey) throw new Error('Activity alerts are not configured yet.')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notifications were not allowed. You can change this in device settings.')
  const registration = await navigator.serviceWorker.ready
  let subscription = await registration.pushManager.getSubscription()
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(data.publicKey),
    })
  }
  await api.post('/notifications/push/subscribe', subscription.toJSON())
  return { subscribed: true }
}

export async function disablePushNotifications() {
  if (!canUseWebPush()) return { subscribed: false }
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return { subscribed: false }
  await api.delete('/notifications/push/subscribe', { data: { endpoint: subscription.endpoint } })
  await subscription.unsubscribe()
  return { subscribed: false }
}
