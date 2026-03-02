import { Platform } from 'react-native';

import WatchBridge from '../watch/WatchBridge';
import WearBridge from '../watch/WearBridge';

const BROADCAST_INTERVAL_MS = 5000;

class WorkoutBroadcastService {
  constructor() {
    this.intervalRef = null;
    this.payloadFactory = null;
    this.workoutType = null;
  }

  getBridge() {
    if (Platform.OS === 'ios') return WatchBridge;
    if (Platform.OS === 'android') return WearBridge;
    return null;
  }

  async start({ workoutType, getPayload }) {
    if (typeof getPayload !== 'function') return;

    this.payloadFactory = getPayload;
    this.workoutType = workoutType || 'run';

    if (this.intervalRef) {
      clearInterval(this.intervalRef);
      this.intervalRef = null;
    }

    const bridge = this.getBridge();
    await bridge?.activateSession?.();
    await this.sendNow();

    this.intervalRef = setInterval(() => {
      this.sendNow();
    }, BROADCAST_INTERVAL_MS);
  }

  stop() {
    if (this.intervalRef) {
      clearInterval(this.intervalRef);
      this.intervalRef = null;
    }

    this.payloadFactory = null;
    this.workoutType = null;
  }

  async sendNow() {
    if (!this.payloadFactory) return;

    const bridge = this.getBridge();
    if (!bridge) return;

    const payload = {
      type: 'workout_update',
      workoutType: this.workoutType || 'run',
      timestamp: new Date().toISOString(),
      ...(this.payloadFactory() || {})
    };

    await bridge.sendUpdate(payload);
  }

  subscribeConnection(callback) {
    const bridge = this.getBridge();
    if (!bridge?.subscribeConnection) return () => {};
    return bridge.subscribeConnection(callback);
  }

  subscribeControls(callback) {
    const bridge = this.getBridge();
    if (!bridge?.subscribeControls) return () => {};
    return bridge.subscribeControls(callback);
  }

  getConnectionState() {
    const bridge = this.getBridge();
    return bridge?.getConnectionState?.() || {
      available: false,
      connected: false,
      reachable: false,
      sessionActive: false
    };
  }
}

const WorkoutBroadcast = new WorkoutBroadcastService();

export default WorkoutBroadcast;
