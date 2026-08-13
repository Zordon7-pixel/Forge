import axios from 'axios'
import { clearToken, getToken } from './tokenStore'

export const API_MUTATION_STATE_EVENT = 'forge:api-mutation-state'

// On native (Capacitor) builds the app runs on-device so relative URLs don't work.
// VITE_API_URL must be set to the absolute Railway URL for production native builds.
export const API_BASE_URL = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api'

const api = axios.create({ baseURL: API_BASE_URL, timeout: 15000 })

let pendingMutationCount = 0

function isMutation(config = {}) {
  return ['post', 'put', 'patch', 'delete'].includes(String(config.method || 'get').toLowerCase())
}

function publishMutationState() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  window.dispatchEvent(new CustomEvent(API_MUTATION_STATE_EVENT, {
    detail: { pendingMutationCount },
  }))
}

function beginMutation(config) {
  if (!isMutation(config) || config.__forgeMutationPending) return
  config.__forgeMutationPending = true
  pendingMutationCount += 1
  publishMutationState()
}

function settleMutation(config) {
  if (!config?.__forgeMutationPending) return
  config.__forgeMutationPending = false
  pendingMutationCount = Math.max(0, pendingMutationCount - 1)
  publishMutationState()
}

export function hasPendingApiMutation() {
  return pendingMutationCount > 0
}

api.interceptors.request.use(cfg => {
  const token = getToken()
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  const now = new Date()
  const localDate = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  cfg.headers['X-Forged-Local-Date'] = localDate
  cfg.headers['X-Forged-Timezone-Offset-Minutes'] = String(now.getTimezoneOffset())
  beginMutation(cfg)
  return cfg
})

function isAuthFlow(url = '') {
  return ['/auth/login', '/auth/register', '/auth/forgot-password', '/auth/reset-password']
    .some((path) => String(url).includes(path))
}

api.interceptors.response.use(
  response => {
    settleMutation(response.config)
    return response
  },
  error => {
    settleMutation(error?.config)
    if (error?.response?.status === 401 && !isAuthFlow(error.config?.url)) {
      clearToken()
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.assign('/login')
      }
    }
    return Promise.reject(error)
  }
)

export default api

export const getWaiverVersion = () => api.get('/consent/version')
export const getCurrentWaiver = () => api.get('/consent/current')
export const acceptWaiver = (version) => api.post('/consent/accept', { version })
