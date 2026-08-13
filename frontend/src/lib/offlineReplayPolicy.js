export function isReplayUnsafeQueuedRequest(item = {}) {
  const method = String(item.method || 'POST').toUpperCase()
  if (!['POST', 'PUT', 'PATCH'].includes(method)) return false
  let pathname = ''
  try {
    pathname = new URL(String(item.url || ''), 'https://forge.invalid').pathname
  } catch {
    return false
  }
  return /^\/api\/races\/[^/]+\/removal-(?:preview|apply)$/.test(pathname)
    || /^\/api\/plans\/adaptation\/[^/]+\/(?:accept|keep)$/.test(pathname)
}
