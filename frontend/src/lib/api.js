import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('forge_token')
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  return cfg
})

export default api
