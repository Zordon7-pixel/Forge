export function createPullToRefreshEndHandler({
  refreshInFlight,
  shouldRefresh,
  onRefreshStart,
  runPageRefresh,
  onRefreshFailure,
  resetGesture,
}) {
  return async function onTouchEnd() {
    if (refreshInFlight.current || !shouldRefresh()) {
      resetGesture()
      return false
    }

    refreshInFlight.current = true

    try {
      onRefreshStart()
      await runPageRefresh()
      return true
    } catch (error) {
      refreshInFlight.current = false
      onRefreshFailure(error)
      return false
    } finally {
      resetGesture()
    }
  }
}
