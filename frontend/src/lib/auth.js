import { getToken, clearToken } from './tokenStore.js'

export function getUser() {
  try {
    const token = getToken()
    if (!token) return null

    const payload = token.split('.')[1]
    if (!payload) return null

    const decoded = payload.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(decoded))
  } catch {
    return null
  }
}

export function getAuthenticatedUserId(now = Date.now()) {
  const user = getUser()
  const expiresAt = Number(user?.exp)
  if (!user || !Number.isFinite(expiresAt) || expiresAt <= now / 1000) return null
  if (user.id === null || user.id === undefined) return null
  const userId = String(user.id).trim()
  return userId || null
}

export function isLoggedIn() {
  try {
    return getAuthenticatedUserId() !== null
  } catch {
    return false
  }
}

export function logout() {
  clearToken()
}
