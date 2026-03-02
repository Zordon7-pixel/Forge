import { Platform } from 'react-native';

let wearModule = null;

if (Platform.OS === 'android') {
  try {
    // eslint-disable-next-line global-require
    wearModule = require('react-native-wear-connectivity');
  } catch {
    wearModule = null;
  }
}

const state = {
  available: Boolean(wearModule),
  sessionActive: false,
  connected: false,
  reachable: false,
  lastError: null
};

const connectionSubscribers = new Set();
const controlSubscribers = new Set();
const unsubscribeFns = [];
let listenersAttached = false;

const isAndroid = () => Platform.OS === 'android';

const emitConnection = () => {
  connectionSubscribers.forEach((callback) => callback({ ...state }));
};

const emitControl = (control) => {
  controlSubscribers.forEach((callback) => callback(control));
};

const sanitizeControl = (message) => {
  const raw = (message?.action || message?.control || '').toString().toLowerCase();
  if (raw === 'start' || raw === 'pause' || raw === 'stop') {
    return raw;
  }
  return null;
};

const makeSummary = (payload) => {
  const pace = payload?.pace || '--:--';
  const distance = Number.isFinite(payload?.distance) ? payload.distance.toFixed(2) : '0.00';
  const heartRate = payload?.heartRate ? `${payload.heartRate} bpm` : '-- bpm';
  const elapsed = Number.isFinite(payload?.elapsed) ? payload.elapsed : 0;
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, '0');
  return `${distance} mi • ${pace}/mi • ${heartRate} • ${mm}:${ss}`;
};

const WearBridge = {
  async activateSession() {
    if (!isAndroid() || !wearModule) return false;
    if (state.sessionActive) return true;

    try {
      if (wearModule.watchEvents?.on && !listenersAttached) {
        listenersAttached = true;
        unsubscribeFns.push(
          wearModule.watchEvents.on('message', (message) => {
            state.connected = true;
            state.reachable = true;
            emitConnection();

            const action = sanitizeControl(message);
            if (action) {
              emitControl({ action, source: 'wear-os', payload: message });
            }
          })
        );
      }

      state.sessionActive = true;
      state.lastError = null;
      emitConnection();
      return true;
    } catch (error) {
      state.lastError = error?.message || 'wear_activation_failed';
      state.sessionActive = false;
      emitConnection();
      return false;
    }
  },

  async sendUpdate(payload = {}) {
    if (!isAndroid() || !wearModule) return false;

    await this.activateSession();

    const message = {
      type: 'workout_update',
      source: 'forge-phone',
      summary: makeSummary(payload),
      ...payload
    };

    return new Promise((resolve) => {
      wearModule.sendMessage(
        message,
        () => {
          state.connected = true;
          state.reachable = true;
          state.lastError = null;
          emitConnection();
          resolve(true);
        },
        (error) => {
          state.reachable = false;
          state.lastError = error?.message || error || 'wear_send_failed';
          emitConnection();
          resolve(false);
        }
      );
    });
  },

  getConnectionState() {
    return { ...state };
  },

  subscribeConnection(callback) {
    connectionSubscribers.add(callback);
    callback({ ...state });
    return () => connectionSubscribers.delete(callback);
  },

  subscribeControls(callback) {
    controlSubscribers.add(callback);
    return () => controlSubscribers.delete(callback);
  },

  reset() {
    while (unsubscribeFns.length) {
      const unsubscribe = unsubscribeFns.pop();
      if (typeof unsubscribe === 'function') unsubscribe();
    }
    state.sessionActive = false;
    listenersAttached = false;
    emitConnection();
  }
};

export default WearBridge;
