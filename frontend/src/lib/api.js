import axios from 'axios'

// On native (Capacitor) builds the app runs on-device so relative URLs don't work.
// VITE_API_URL must be set to the absolute Railway URL for production native builds.
const baseURL = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api'

const api = axios.create({ baseURL })

api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('forge_token')
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  return cfg
})

export default api
