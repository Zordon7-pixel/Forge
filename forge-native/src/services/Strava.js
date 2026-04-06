import api from '../lib/api';

export const getStatus = async () => {
  const response = await api.get('/strava/status');
  return response?.data || { connected: false, athlete_name: null, last_sync: null };
};

export const syncActivities = async () => {
  const response = await api.post('/strava/sync');
  return response?.data || { imported: 0, total: 0 };
};

export const disconnect = async () => {
  const response = await api.delete('/strava/disconnect');
  return response?.data || { connected: false };
};
