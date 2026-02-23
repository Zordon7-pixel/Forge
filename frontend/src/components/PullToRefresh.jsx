import { useEffect, useRef, useState } from 'react'

const THRESHOLD = 80 // px to pull before triggering refresh

export default function PullToRefresh({ children }) {
  const [pulling, setPulling] = useState(false)
  const [pullDistance, setPullDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const startY = useRef(null)
  const containerRef = useRef(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onTouchStart = (e) => {
      // Only activate when scrolled to the very top
      if (window.scrollY === 0) {
        startY.current = e.touches[0].clientY
      }
    }

    const onTouchMove = (e) => {
      if (startY.current === null) return
      const diff = e.touches[0].clientY - startY.current
      if (diff > 0 && window.scrollY === 0) {
        setPulling(true)
        setPullDistance(Math.min(diff, THRESHOLD + 20))
        // Prevent default scroll bounce when pulling
        if (diff > 10) e.preventDefault()
      }
    }

    const onTouchEnd = async () => {
      if (pulling && pullDistance >= THRESHOLD) {
        setRefreshing(true)
        setPullDistance(THRESHOLD)
        // Give a brief moment for the spinner to show
        await new Promise(r => setTimeout(r, 800))
        window.location.reload()
      }
      startY.current = null
      setPulling(false)
      setPullDistance(0)
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)

    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }, [pulling, pullDistance])

  const progress = Math.min(pullDistance / THRESHOLD, 1)
  const showIndicator = pulling && pullDistance > 10

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {/* Pull indicator */}
      {(showIndicator || refreshing) && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          zIndex: 100,
          pointerEvents: 'none',
          transform: `translateY(${refreshing ? 12 : Math.max(pullDistance - 40, 0)}px)`,
          transition: refreshing ? 'transform 0.2s ease' : 'none',
        }}>
          <div style={{
            width: 36,
            height: 36,
            borderRadius: '50%',
            background: 'var(--bg-card)',
            border: '2px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
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
