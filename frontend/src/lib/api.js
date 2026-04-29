import axios from 'axios'
import { getToken } from './tokenStore'

// On native (Capacitor) builds the app runs on-device so relative URLs don't work.
// VITE_API_URL must be set to the absolute Railway URL for production native builds.
export const API_BASE_URL = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api'

const api = axios.create({ baseURL: API_BASE_URL })

api.interceptors.request.use(cfg => {
  const token = getToken()
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  return cfg
})

export default api
