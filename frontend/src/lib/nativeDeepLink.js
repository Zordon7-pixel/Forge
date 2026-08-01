const ACTIVE_RUN_PATH = '/run/active'

export function normalizeForgedDeepLink(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'forgedhybrid:') return null
    const path = `/${[url.hostname, url.pathname].filter(Boolean).join('/')}`.replace(/\/{2,}/g, '/')
    if (path !== ACTIVE_RUN_PATH) return null
    const command = String(url.searchParams.get('command') || '').toLowerCase()
    return ['pause', 'resume'].includes(command)
      ? `${ACTIVE_RUN_PATH}?command=${command}`
      : ACTIVE_RUN_PATH
  } catch {
    return null
  }
}
