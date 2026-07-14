export const SWIPE_BACK_EDGE_PX = 28
export const SWIPE_BACK_DISTANCE_PX = 78
export const SWIPE_BACK_MAX_DURATION_MS = 1000
export const SWIPE_BACK_EVENT = 'forge:swipe-back'

const BLOCKED_ROUTES = [
  /^\/$/,
  /^\/run\/active(?:\/|$)/,
  /^\/workout\/active(?:\/|$)/,
]

export function isSwipeBackRouteEnabled(pathname = '') {
  return !BLOCKED_ROUTES.some((pattern) => pattern.test(String(pathname)))
}

export function isCompletedSwipeBack({ startX, startY, endX, endY, elapsedMs }) {
  const horizontal = Number(endX) - Number(startX)
  const vertical = Math.abs(Number(endY) - Number(startY))
  return Number(startX) <= SWIPE_BACK_EDGE_PX
    && horizontal >= SWIPE_BACK_DISTANCE_PX
    && horizontal >= vertical * 1.5
    && Number(elapsedMs) <= SWIPE_BACK_MAX_DURATION_MS
}

export function isSwipeBackUnsafeSessionStatus(status = '') {
  return ['running', 'paused', 'done'].includes(String(status))
}
