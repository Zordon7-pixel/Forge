import axios from 'axios';

import { getToken } from './storage';

const api = axios.create({
  baseURL: 'http://100.102.219.60:4002/api',
  timeout: 15000
});

api.interceptors.request.use(async (config) => {
  const token = await getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default api;
