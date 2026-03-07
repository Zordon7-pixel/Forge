import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'forge_offline_queue_v1';
const listeners = new Set();
let appStateSubscription = null;
let initialized = false;
let flushing = false;

const emit = (status) => {
  listeners.forEach((listener) => {
    try {
      listener(status);
    } catch {
      // Ignore listener errors.
    }
  });
};

const safeParse = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const readQueue = async () => {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  const parsed = safeParse(raw, []);
  return Array.isArray(parsed) ? parsed : [];
};

const writeQueue = async (items) => {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
};

const shouldStore = (config = {}, error = null) => {
  const method = String(config?.method || '').toUpperCase();
  if (!['POST', 'PATCH', 'DELETE'].includes(method)) return false;
  if (config?.__fromOfflineQueue) return false;
  if (!error) return true;
  return true;
};

const serializeRequest = (config = {}) => {
  let data = config?.data;
  if (typeof data === 'string') {
    data = safeParse(data, data);
  }

  return {
    method: String(config?.method || 'POST').toUpperCase(),
    url: config?.url,
    params: config?.params || null,
    data: data ?? null,
    queuedAt: new Date().toISOString(),
  };
};

export const queueOfflineRequest = async (config, error = null) => {
  if (!shouldStore(config, error)) return false;
  const item = serializeRequest(config);
  if (!item.url) return false;

  const queue = await readQueue();
  queue.push(item);
  await writeQueue(queue);
  emit({ syncing: false, pending: queue.length, last: 'queued' });
  return true;
};

export const flushOfflineQueue = async (client) => {
  if (!client || flushing) return;

  const currentQueue = await readQueue();
  if (!currentQueue.length) {
    emit({ syncing: false, pending: 0, last: 'idle' });
    return;
  }

  flushing = true;
  emit({ syncing: true, pending: currentQueue.length, last: 'syncing' });

  const remaining = [];

  for (const item of currentQueue) {
    try {
      await client({
        method: item.method,
        url: item.url,
        params: item.params || undefined,
        data: item.data ?? undefined,
        __fromOfflineQueue: true,
      });
    } catch {
      remaining.push(item);
    }
  }

  await writeQueue(remaining);
  flushing = false;

  emit({
    syncing: false,
    pending: remaining.length,
    last: remaining.length ? 'partial' : 'complete',
  });
};

export const initOfflineQueue = (client) => {
  if (initialized) return;
  initialized = true;

  appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      flushOfflineQueue(client);
    }
  });

  flushOfflineQueue(client);
};

export const subscribeSyncStatus = (listener) => {
  listeners.add(listener);
  listener({ syncing: false, pending: 0, last: 'idle' });
  return () => listeners.delete(listener);
};

export const teardownOfflineQueue = () => {
  if (appStateSubscription?.remove) {
    appStateSubscription.remove();
  }
  appStateSubscription = null;
  initialized = false;
};
