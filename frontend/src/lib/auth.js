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

export function isLoggedIn() {
  try {
    const token = getToken()
    if (!token) return false

    const user = getUser()
    return !!user && user.exp > Date.now() / 1000
  } catch {
    return false
  }
}

export function logout() {
  clearToken()
}
