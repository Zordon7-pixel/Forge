import { useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { isLoggedIn } from '../lib/auth'
import { runHealthAwarePageRefresh } from '../lib/healthSync'
import {
  createPullToRefreshEndHandler,
  measurePullRefreshGesture,
  PULL_REFRESH_THRESHOLD_PX,
  readPullRefreshScrollTop,
} from '../lib/pullToRefresh'
import HealthService from '../services/HealthService'

const PULL_REFRESH_IGNORE_SELECTOR = [
  '[data-pull-refresh-ignore]',
  '.leaflet-container',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="slider"]',
].join(',')

function shouldIgnorePullTarget(target) {
  return typeof Element !== 'undefined' && target instanceof Element
    ? Boolean(target.closest(PULL_REFRESH_IGNORE_SELECTOR))
    : false
}

export default function PullToRefresh({ children }) {
  const [pulling, setPulling] = useState(false)
  const [pullDistance, setPullDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const refreshInFlight = useRef(false)
  const gestureRef = useRef(null)

  useEffect(() => {
    const resetGesture = () => {
      gestureRef.current = null
      setPulling(false)
      setPullDistance(0)
    }

    const onTouchStart = (event) => {
      if (
        refreshInFlight.current
        || event.touches.length !== 1
        || readPullRefreshScrollTop() > 1
        || shouldIgnorePullTarget(event.target)
      ) return

      const touch = event.touches[0]
      gestureRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        distance: 0,
        pulling: false,
      }
    }

    const onTouchMove = (event) => {
      const gesture = gestureRef.current
      if (!gesture || event.touches.length !== 1) return

      const touch = event.touches[0]
      const measurement = measurePullRefreshGesture({
        startX: gesture.startX,
        startY: gesture.startY,
        currentX: touch.clientX,
        currentY: touch.clientY,
        atTop: readPullRefreshScrollTop() <= 1,
      })

      if (measurement.cancelled) {
        resetGesture()
        return
      }

      gesture.distance = measurement.distance
      gesture.pulling = measurement.pulling
      if (!measurement.pulling) return

      setPulling(true)
      setPullDistance(measurement.distance)
      event.preventDefault()
    }

    const onTouchEnd = createPullToRefreshEndHandler({
      refreshInFlight,
      shouldRefresh: () => Boolean(
        gestureRef.current?.pulling
        && gestureRef.current.distance >= PULL_REFRESH_THRESHOLD_PX
      ),
      onRefreshStart: () => {
        setRefreshing(true)
        setPullDistance(PULL_REFRESH_THRESHOLD_PX)
      },
      runPageRefresh: async () => {
        await runHealthAwarePageRefresh({
          authenticated: isLoggedIn(),
          native: Capacitor.isNativePlatform(),
          syncNativeData: (options) => HealthService.syncNativeData(options),
          onHealthSyncError: (error) => {
            console.error('[PullToRefresh] Apple Health sync failed:', error?.message || error)
          },
          // Let the completion state paint before page data is requested again.
          afterHealthSync: () => new Promise(r => setTimeout(r, 150)),
          refreshPage: () => window.location.reload(),
        })
      },
      onRefreshFailure: (error) => {
        console.error('[PullToRefresh] Page refresh failed:', error?.message || error)
        setRefreshing(false)
      },
      resetGesture,
    })

    const onTouchCancel = () => resetGesture()

    // Listen above the sticky app header so every primary tab has the same
    // pull-to-sync gesture, regardless of which element the pull starts on.
    window.addEventListener('touchstart', onTouchStart, { passive: true, capture: true })
    window.addEventListener('touchmove', onTouchMove, { passive: false, capture: true })
    window.addEventListener('touchend', onTouchEnd, { passive: true, capture: true })
    window.addEventListener('touchcancel', onTouchCancel, { passive: true, capture: true })

    return () => {
      window.removeEventListener('touchstart', onTouchStart, true)
      window.removeEventListener('touchmove', onTouchMove, true)
      window.removeEventListener('touchend', onTouchEnd, true)
      window.removeEventListener('touchcancel', onTouchCancel, true)
    }
  }, [])

  const progress = Math.min(pullDistance / PULL_REFRESH_THRESHOLD_PX, 1)
  const showIndicator = pulling && pullDistance > 10
  const nativeHealthSync = Capacitor.isNativePlatform() && isLoggedIn()
  const indicatorLabel = refreshing
    ? nativeHealthSync ? 'Syncing Apple Health' : 'Refreshing app'
    : progress >= 1 ? 'Release to sync' : 'Pull to sync'

  return (
    <div style={{ position: 'relative' }}>
      {/* Pull indicator */}
      {(showIndicator || refreshing) && (
        <div role="status" aria-live="polite" style={{
          position: 'fixed',
          top: 'calc(env(safe-area-inset-top, 0px) + 0.5rem)',
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          zIndex: 10000,
          pointerEvents: 'none',
          transform: `translateY(${refreshing ? 0 : Math.max(pullDistance - 40, 0)}px)`,
          transition: refreshing ? 'transform 0.2s ease' : 'none',
        }}>
          <div style={{
            minWidth: 36,
            height: 36,
            padding: '0 12px',
            borderRadius: 18,
            background: 'var(--bg-card)',
            border: '2px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            boxShadow: 'var(--shadow-raised)',
          }}>
            <svg
              width="18" height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2.5"
              strokeLinecap="round"
              style={{
                transform: refreshing ? 'none' : `rotate(${progress * 360}deg)`,
                animation: refreshing ? 'ptr-spin 0.7s linear infinite' : 'none',
              }}
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <span style={{
              color: 'var(--text-primary)',
              fontSize: 12,
              fontWeight: 800,
              whiteSpace: 'nowrap',
            }}>
              {indicatorLabel}
            </span>
          </div>
        </div>
      )}

      {/* Spacer that pushes content down while pulling */}
      {showIndicator && (
        <div style={{ height: Math.max(pullDistance - 40, 0), transition: 'height 0.1s' }} />
      )}

      <style>{`
        @keyframes ptr-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>

      {children}
    </div>
  )
}
