import axios from 'axios';

import { getToken } from './storage';
import { initOfflineQueue, queueOfflineRequest } from '../utils/offlineQueue';

const api = axios.create({
  baseURL: 'https://forge-production-773f.up.railway.app/api',
  timeout: 15000
});

api.interceptors.request.use(async (config) => {
  const token = await getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const queued = await queueOfflineRequest(error?.config || {}, error);
    if (queued) {
      error.isQueued = true;
      error.message = error.message || 'Request queued for sync.';
    }
    return Promise.reject(error);
  }
);

initOfflineQueue(api);

export default api;
