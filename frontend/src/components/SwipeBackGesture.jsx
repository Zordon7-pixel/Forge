import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'
import {
  isCompletedSwipeBack,
  isSwipeBackRouteEnabled,
  SWIPE_BACK_EDGE_PX,
  SWIPE_BACK_EVENT,
} from '../lib/swipeBack'

const IGNORE_SELECTOR = [
  '[data-swipe-back-ignore]',
  '.leaflet-container',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="slider"]',
].join(',')

function shouldIgnoreTarget(target) {
  return typeof Element !== 'undefined' && target instanceof Element
    ? Boolean(target.closest(IGNORE_SELECTOR))
    : false
}

export default function SwipeBackGesture({ onBeforeBack }) {
  const location = useLocation()
  const navigate = useNavigate()
  const gestureRef = useRef(null)

  useEffect(() => {
    gestureRef.current = null
    if (!isSwipeBackRouteEnabled(location.pathname)) return undefined

    const onTouchStart = (event) => {
      if (event.touches.length !== 1) return
      const touch = event.touches[0]
      if (touch.clientX > SWIPE_BACK_EDGE_PX || shouldIgnoreTarget(event.target)) return
      gestureRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        endX: touch.clientX,
        endY: touch.clientY,
        startedAt: Date.now(),
        horizontal: false,
      }
    }

    const onTouchMove = (event) => {
      const gesture = gestureRef.current
      if (!gesture || event.touches.length !== 1) return
      const touch = event.touches[0]
      gesture.endX = touch.clientX
      gesture.endY = touch.clientY
      const horizontal = gesture.endX - gesture.startX
      const vertical = Math.abs(gesture.endY - gesture.startY)
      if (horizontal > 12 && horizontal >= vertical * 1.5) {
        gesture.horizontal = true
        event.preventDefault()
      }
    }

    const finishGesture = () => {
      const gesture = gestureRef.current
      gestureRef.current = null
      if (!gesture?.horizontal) return
      if (!isCompletedSwipeBack({
        ...gesture,
        elapsedMs: Date.now() - gesture.startedAt,
      })) return

      if (onBeforeBack?.()) return

      const backEvent = new CustomEvent(SWIPE_BACK_EVENT, { cancelable: true })
      if (!window.dispatchEvent(backEvent)) return

      const historyIndex = Number(window.history.state?.idx)
      if (Number.isFinite(historyIndex) && historyIndex > 0) navigate(-1)
      else navigate('/')
    }

    const cancelGesture = () => {
      gestureRef.current = null
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', finishGesture, { passive: true })
    window.addEventListener('touchcancel', cancelGesture, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', finishGesture)
      window.removeEventListener('touchcancel', cancelGesture)
    }
  }, [location.pathname, navigate, onBeforeBack])

  return null
}
