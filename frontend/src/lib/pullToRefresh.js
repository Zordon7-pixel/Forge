export const PULL_REFRESH_INTENT_PX = 10
export const PULL_REFRESH_THRESHOLD_PX = 72
export const PULL_REFRESH_MAX_DISTANCE_PX = 96

export function readPullRefreshScrollTop(
  documentRef = globalThis.document,
  windowRef = globalThis.window,
) {
  const documentTop = Number(documentRef?.scrollingElement?.scrollTop)
  if (Number.isFinite(documentTop)) return Math.max(0, documentTop)

  const windowTop = Number(windowRef?.scrollY)
  return Number.isFinite(windowTop) ? Math.max(0, windowTop) : 0
}

export function measurePullRefreshGesture({
  startX,
  startY,
  currentX,
  currentY,
  atTop,
}) {
  const deltaX = Number(currentX) - Number(startX)
  const deltaY = Number(currentY) - Number(startY)
  const horizontalDistance = Math.abs(deltaX)

  if (!atTop || deltaY <= 0) {
    return { cancelled: true, pulling: false, distance: 0 }
  }

  if (
    horizontalDistance >= PULL_REFRESH_INTENT_PX
    && horizontalDistance > deltaY
  ) {
    return { cancelled: true, pulling: false, distance: 0 }
  }

  return {
    cancelled: false,
    pulling: deltaY >= PULL_REFRESH_INTENT_PX && deltaY >= horizontalDistance,
    distance: Math.min(deltaY, PULL_REFRESH_MAX_DISTANCE_PX),
  }
}

export function createPullToRefreshEndHandler({
  refreshInFlight,
  shouldRefresh,
  onRefreshStart,
  runPageRefresh,
  onRefreshFailure,
  resetGesture,
}) {
  return async function onTouchEnd(event) {
    if (event?.touches?.length > 0 || refreshInFlight.current || !shouldRefresh()) {
      resetGesture()
      return false
    }

    refreshInFlight.current = true

    try {
      onRefreshStart()
      await runPageRefresh()
      return true
    } catch (error) {
      onRefreshFailure(error)
      return false
    } finally {
      refreshInFlight.current = false
      resetGesture()
    }
  }
}
