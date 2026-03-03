import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

import api from '../lib/api';

const GARMIN_BASE_URL = 'https://connect.garmin.com';
const GARMIN_SSO_URL = 'https://sso.garmin.com/sso';
const GARMIN_SERVICE_URL = `${GARMIN_BASE_URL}/modern`;
const GARMIN_SOURCE_URL = `${GARMIN_BASE_URL}/en-US/signin`;

const SECURE_KEYS = {
  credentials: 'forge_garmin_credentials',
  syncMeta: 'forge_garmin_sync_meta',
  syncedIds: 'forge_garmin_synced_ids'
};

const SUPPORTED_RUN_TYPES = ['running', 'cycling', 'walking'];
const SUPPORTED_LIFT_TYPES = ['strength_training', 'strength', 'yoga'];

const getDateDaysAgo = (days) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split('T')[0];
};

const formatPace = (durationSeconds, distanceMiles) => {
  if (!durationSeconds || !distanceMiles) return '0:00';
  const totalMinutes = durationSeconds / 60 / distanceMiles;
  const minutes = Math.floor(totalMinutes);
  const seconds = Math.round((totalMinutes - minutes) * 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const parseStoredJson = async (key, fallback) => {
  try {
    const value = await SecureStore.getItemAsync(key);
    if (!value) return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const saveJson = async (key, value) => {
  await SecureStore.setItemAsync(key, JSON.stringify(value));
};

const normalizeType = (activity = {}) => {
  const fromObject = activity?.activityType?.typeKey || activity?.activityTypeDTO?.typeKey || activity?.activityType?.parentTypeId;
  const fromString = activity?.activityType?.typeKey || activity?.activityName;
  return String(fromObject || fromString || activity?.type || '').toLowerCase();
};

const extractTicketUrl = (responseBody) => {
  const html = String(responseBody || '');
  const directMatch = html.match(/https:\/\/connect\.garmin\.com\/modern[^"']*ticket=[^"']+/i);
  if (directMatch?.[0]) {
    return directMatch[0];
  }
  return null;
};

const mapAuthError = (error) => {
  if (error?.isGarminAuthError) {
    return error;
  }

  const status = error?.response?.status;
  const payloadText = String(error?.response?.data || '').toLowerCase();

  if (status === 401 || status === 403 || payloadText.includes('invalid') || payloadText.includes('locked')) {
    return new Error('Garmin authentication failed. Check your email/password or account status.');
  }

  if (status >= 500) {
    return new Error('Garmin Connect is temporarily unavailable. Please try again later.');
  }

  if (error?.message?.toLowerCase().includes('network')) {
    return new Error('Network error while connecting to Garmin. Check your connection and retry.');
  }

  return new Error('Unable to connect to Garmin Connect right now.');
};

const createClients = () => {
  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0',
    Accept: 'application/json, text/plain, */*'
  };

  const ssoClient = axios.create({
    baseURL: GARMIN_SSO_URL,
    timeout: 30000,
    withCredentials: true,
    headers: commonHeaders
  });

  const connectClient = axios.create({
    baseURL: GARMIN_BASE_URL,
    timeout: 30000,
    withCredentials: true,
    headers: commonHeaders
  });

  return { ssoClient, connectClient };
};

const authenticate = async (username, password) => {
  try {
    const { ssoClient, connectClient } = createClients();

    await ssoClient.get('/embed', {
      params: {
        id: 'gauth-widget',
        embedWidget: 'true',
        gauthHost: GARMIN_SSO_URL,
        service: GARMIN_SERVICE_URL,
        source: GARMIN_SOURCE_URL,
        redirectAfterAccountLoginUrl: GARMIN_SERVICE_URL
      }
    });

    const body = new URLSearchParams({
      username,
      password,
      embed: 'true',
      _eventId: 'submit'
    }).toString();

    const signInResponse = await ssoClient.post('/signin', body, {
      params: { service: GARMIN_SERVICE_URL },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const ticketUrl = extractTicketUrl(signInResponse?.data);
    if (!ticketUrl) {
      const authError = new Error('Garmin authentication failed. Check your email/password or account status.');
      authError.isGarminAuthError = true;
      throw authError;
    }

    await connectClient.get(ticketUrl);

    const profileResponse = await connectClient.get('/modern/proxy/userprofile-service/socialProfile');

    return {
      connectClient,
      profile: profileResponse?.data || null
    };
  } catch (error) {
    throw mapAuthError(error);
  }
};

const toRunPayload = (activity) => {
  const distanceMiles = Number(activity.distance || 0) / 1609.34;
  const duration = Number(activity.duration || activity.movingDuration || 0);
  const calories = Number(activity.calories || 0);
  const pace = formatPace(duration, distanceMiles);

  return {
    distance: Number(distanceMiles.toFixed(2)),
    duration,
    pace,
    calories: Number.isFinite(calories) ? calories : 0,
    date: activity.startTimeGMT || activity.startTimeLocal || new Date().toISOString()
  };
};

const toLiftPayload = (activity) => {
  const activityName = activity.activityName || activity.activityType?.typeKey || 'Garmin Workout';
  return {
    name: activityName,
    sets: [{ reps: 1, weight: 0 }],
    date: activity.startTimeGMT || activity.startTimeLocal || new Date().toISOString()
  };
};

export const connectAccount = async (username, password) => {
  const email = String(username || '').trim();
  const pass = String(password || '');

  if (!email || !pass) {
    throw new Error('Garmin email and password are required.');
  }

  await authenticate(email, pass);
  await saveJson(SECURE_KEYS.credentials, { username: email, password: pass });
  return { connected: true };
};

export const isConnected = async () => {
  const creds = await parseStoredJson(SECURE_KEYS.credentials, null);
  return Boolean(creds?.username && creds?.password);
};

export const disconnect = async () => {
  await Promise.all([
    SecureStore.deleteItemAsync(SECURE_KEYS.credentials),
    SecureStore.deleteItemAsync(SECURE_KEYS.syncMeta),
    SecureStore.deleteItemAsync(SECURE_KEYS.syncedIds)
  ]);
};

export const getRecentActivities = async (days = 30) => {
  const creds = await parseStoredJson(SECURE_KEYS.credentials, null);
  if (!creds?.username || !creds?.password) {
    throw new Error('Garmin account is not connected.');
  }

  try {
    const { connectClient } = await authenticate(creds.username, creds.password);
    const response = await connectClient.get('/modern/proxy/activitylist-service/activities/search/activities', {
      params: {
        start: 0,
        limit: 100,
        startDate: getDateDaysAgo(days)
      }
    });
    return Array.isArray(response?.data) ? response.data : [];
  } catch (error) {
    throw mapAuthError(error);
  }
};

export const syncActivities = async () => {
  const [activities, syncedIds] = await Promise.all([
    getRecentActivities(30),
    parseStoredJson(SECURE_KEYS.syncedIds, [])
  ]);

  const syncedSet = new Set(syncedIds.map((id) => String(id)));
  let importedRuns = 0;
  let importedLifts = 0;
  const newlySynced = [];

  for (const activity of activities) {
    const activityId = String(activity?.activityId || '');
    if (!activityId || syncedSet.has(activityId)) {
      continue;
    }

    const type = normalizeType(activity);
    try {
      if (SUPPORTED_RUN_TYPES.includes(type)) {
        await api.post('/runs', toRunPayload(activity));
        importedRuns += 1;
        newlySynced.push(activityId);
      } else if (SUPPORTED_LIFT_TYPES.includes(type)) {
        await api.post('/workouts', toLiftPayload(activity));
        importedLifts += 1;
        newlySynced.push(activityId);
      }
    } catch {
      // Continue syncing remaining activities even if one import fails.
    }
  }

  const updatedIds = [...syncedSet, ...newlySynced];
  await saveJson(SECURE_KEYS.syncedIds, updatedIds);

  const meta = {
    lastSyncedAt: new Date().toISOString(),
    importedCount: importedRuns + importedLifts,
    importedRuns,
    importedLifts
  };
  await saveJson(SECURE_KEYS.syncMeta, meta);

  return meta;
};

export const getSyncMeta = async () => parseStoredJson(SECURE_KEYS.syncMeta, null);
