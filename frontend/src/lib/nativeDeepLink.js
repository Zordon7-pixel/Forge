const ACTIVE_RUN_PATH = '/run/active'

export function normalizeForgedDeepLink(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'forgedhybrid:') return null
    const path = `/${[url.hostname, url.pathname].filter(Boolean).join('/')}`.replace(/\/{2,}/g, '/')
    return path === ACTIVE_RUN_PATH ? ACTIVE_RUN_PATH : null
  } catch {
    return null
  }
}
