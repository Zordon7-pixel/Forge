import { useCallback, useEffect, useState } from 'react'
import { flushQueue, getQueueCount } from './offlineQueue'

export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  const [queueCount, setQueueCount] = useState(0)

  const refreshQueueCount = useCallback(async () => {
    try {
      const count = await getQueueCount()
      setQueueCount(count)
    } catch {
      setQueueCount(0)
    }
  }, [])

  const flushAndRefresh = useCallback(async () => {
    try {
      await flushQueue()
    } finally {
      await refreshQueueCount()
    }
  }, [refreshQueueCount])

  useEffect(() => {
    refreshQueueCount()
  }, [refreshQueueCount])

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true)
      flushAndRefresh()
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'FLUSH_OFFLINE_QUEUE' })
      }
    }
    const handleOffline = () => setIsOnline(false)
    const handleQueueUpdated = () => refreshQueueCount()

    const handleServiceWorkerMessage = (event) => {
      const type = event?.data?.type
      if (type === 'OFFLINE_QUEUE_UPDATED' || type === 'OFFLINE_QUEUE_FLUSHED') {
        refreshQueueCount()
      }
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    window.addEventListener('offline-queue-updated', handleQueueUpdated)
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage)
    }

    if (navigator.onLine) {
      flushAndRefresh()
    }

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('offline-queue-updated', handleQueueUpdated)
      if (navigator.serviceWorker) {
        navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage)
      }
    }
  }, [flushAndRefresh, refreshQueueCount])

  return { isOnline, queueCount }
}
