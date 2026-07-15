const TOKEN_KEY = 'forge_token'
const POST_AUTH_REDIRECT_KEY = 'forge_post_auth_redirect'
const POST_AUTH_REDIRECT_TTL_MS = 24 * 60 * 60 * 1000

function safeInternalPath(value) {
  const path = String(value || '')
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.length > 600) return ''
  return path
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(POST_AUTH_REDIRECT_KEY)
}

export function rememberPostAuthRedirect(path) {
  const safePath = safeInternalPath(path)
  if (!safePath) return
  localStorage.setItem(POST_AUTH_REDIRECT_KEY, JSON.stringify({ path: safePath, createdAt: Date.now() }))
}

export function consumePostAuthRedirect() {
  try {
    const value = JSON.parse(localStorage.getItem(POST_AUTH_REDIRECT_KEY) || 'null')
    localStorage.removeItem(POST_AUTH_REDIRECT_KEY)
    if (!value || Date.now() - Number(value.createdAt || 0) > POST_AUTH_REDIRECT_TTL_MS) return ''
    return safeInternalPath(value.path)
  } catch {
    localStorage.removeItem(POST_AUTH_REDIRECT_KEY)
    return ''
  }
}
