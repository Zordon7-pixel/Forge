import { useCallback, useEffect, useState } from 'react'
import { Bell, ChevronRight, X } from 'lucide-react'
import { useNavigate } from 'react-router'
import api from '../lib/api'

const SOURCE_LABELS = {
  apple_health: 'Apple Health',
  strava: 'Strava',
  forged_hybrid: 'Forged Hybrid',
}

export default function SyncNotificationBanner() {
  const navigate = useNavigate()
  const [notification, setNotification] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get('/notifications', { params: { unread: 1, limit: 1 } })
      setNotification(data?.notifications?.[0] || null)
    } catch (error) {
      if (error?.response?.status !== 401) console.error('[SyncNotificationBanner] refresh failed:', error?.message || error)
    }
  }, [])

  useEffect(() => {
    refresh()
    const interval = window.setInterval(refresh, 5 * 60_000)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    const handleServiceWorkerMessage = (event) => {
      if (event?.data?.type === 'FORGED_NOTIFICATION_RECEIVED') refresh()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', refresh)
    navigator.serviceWorker?.addEventListener('message', handleServiceWorkerMessage)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', refresh)
      navigator.serviceWorker?.removeEventListener('message', handleServiceWorkerMessage)
    }
  }, [refresh])

  const markRead = async () => {
    if (!notification?.id) return
    const current = notification
    setNotification(null)
    try {
      await api.patch(`/notifications/${current.id}/read`)
    } catch (error) {
      console.error('[SyncNotificationBanner] mark read failed:', error?.message || error)
    }
  }

  const openNotification = async () => {
    const href = notification?.href
    await markRead()
    if (href && href.startsWith('/')) navigate(href)
  }

  if (!notification) return null

  return (
    <div className="mb-3 grid grid-cols-[36px_minmax(0,1fr)_28px] items-center gap-2 rounded-xl p-3" style={{ background: 'var(--accent-dim)', border: '1px solid color-mix(in srgb, var(--accent) 45%, transparent)' }} role="status">
      <button type="button" onClick={openNotification} className="pressable grid h-9 w-9 place-items-center rounded-full" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }} aria-label="Open activity notification"><Bell size={17} /></button>
      <button type="button" onClick={openNotification} className="min-w-0 text-left">
        <span className="mb-0.5 block text-[10px] font-bold uppercase" style={{ color: 'var(--accent)', letterSpacing: 0 }}>{SOURCE_LABELS[notification.source] || 'Forged Hybrid'}</span>
        <span className="block truncate text-sm font-black" style={{ color: 'var(--text-primary)' }}>{notification.title}</span>
        <span className="mt-0.5 block text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>{notification.body}</span>
        {notification.href && <span className="mt-1 inline-flex items-center gap-1 text-xs font-bold" style={{ color: 'var(--accent)' }}>Review <ChevronRight size={13} /></span>}
      </button>
      <button type="button" onClick={markRead} className="pressable grid h-8 w-8 place-items-center" aria-label="Dismiss notification" style={{ color: 'var(--text-muted)' }}><X size={16} /></button>
    </div>
  )
}
