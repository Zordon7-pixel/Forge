import { Platform } from 'react-native';

let watchModule = null;

if (Platform.OS === 'ios') {
  try {
    // eslint-disable-next-line global-require
    watchModule = require('react-native-watch-connectivity');
  } catch {
    watchModule = null;
  }
}

const state = {
  available: Boolean(watchModule),
  sessionActive: false,
  paired: false,
  installed: false,
  reachable: false,
  lastError: null
};

const connectionSubscribers = new Set();
const controlSubscribers = new Set();
const unsubscribeFns = [];
let listenersAttached = false;

const isIOS = () => Platform.OS === 'ios';

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

const activationListeners = () => {
  if (!watchModule?.watchEvents || listenersAttached) return;
  listenersAttached = true;

  unsubscribeFns.push(
    watchModule.watchEvents.on('reachability', (reachable) => {
      state.reachable = Boolean(reachable);
      emitConnection();
    })
  );

  unsubscribeFns.push(
    watchModule.watchEvents.on('paired', (paired) => {
      state.paired = Boolean(paired);
      emitConnection();
    })
  );

  unsubscribeFns.push(
    watchModule.watchEvents.on('installed', (installed) => {
      state.installed = Boolean(installed);
      emitConnection();
    })
  );

  unsubscribeFns.push(
    watchModule.watchEvents.on('activation-error', (error) => {
      state.lastError = error || 'activation_error';
      state.sessionActive = false;
      emitConnection();
    })
  );

  unsubscribeFns.push(
    watchModule.watchEvents.on('message', (message, replyHandler) => {
      const action = sanitizeControl(message);
      if (!action) return;

      emitControl({ action, source: 'apple-watch', payload: message });

      if (typeof replyHandler === 'function') {
        replyHandler({ ok: true, accepted: action });
      }
    })
  );
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

const WatchBridge = {
  async activateSession() {
    if (!isIOS() || !watchModule) return false;
    if (state.sessionActive) return true;

    try {
      activationListeners();

      const [reachable, paired, installed] = await Promise.all([
        watchModule.getReachability?.(),
        watchModule.getIsPaired?.(),
        watchModule.getIsWatchAppInstalled?.()
      ]);

      state.reachable = Boolean(reachable);
      state.paired = Boolean(paired);
      state.installed = Boolean(installed);
      state.sessionActive = true;
      state.lastError = null;
      emitConnection();
      return true;
    } catch (error) {
      state.lastError = error?.message || 'watch_activation_failed';
      state.sessionActive = false;
      emitConnection();
      return false;
    }
  },

  async sendUpdate(payload = {}) {
    if (!isIOS() || !watchModule) return false;

    await this.activateSession();

    const message = {
      type: 'workout_update',
      source: 'forge-phone',
      summary: makeSummary(payload),
      ...payload
    };

    try {
      watchModule.updateApplicationContext?.(message);
    } catch {
      // App context can fail if not currently active; direct message still attempts.
    }

    return new Promise((resolve) => {
      watchModule.sendMessage(
        message,
        () => {
          state.reachable = true;
          emitConnection();
          resolve(true);
        },
        (error) => {
          state.reachable = false;
          state.lastError = error?.message || error || 'watch_send_failed';
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

export default WatchBridge;
