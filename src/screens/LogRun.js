import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { Pause, Play, Save, Square, Watch } from 'lucide-react-native';

import api from '../lib/api';
import { syncRunToHealth } from '../lib/health';
import WorkoutBroadcast from '../services/WorkoutBroadcast';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
  success: '#22c55e',
  error: '#ef4444'
};

const metersToMiles = (meters) => meters / 1609.34;
const toRadians = (value) => (value * Math.PI) / 180;
const calcDistanceMeters = (a, b) => {
  const earthRadius = 6371000;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

const formatDuration = (elapsed) => `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

export default function LogRun() {
  const [status, setStatus] = useState('idle');
  const [elapsed, setElapsed] = useState(0);
  const [distanceMeters, setDistanceMeters] = useState(0);
  const [saving, setSaving] = useState(false);
  const [connection, setConnection] = useState(WorkoutBroadcast.getConnectionState());

  const watchRef = useRef(null);
  const timerRef = useRef(null);
  const previousCoordsRef = useRef(null);

  const elapsedRef = useRef(0);
  const distanceRef = useRef(0);
  const paceRef = useRef('0:00');
  const statusRef = useRef('idle');

  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);

  useEffect(() => {
    distanceRef.current = distanceMeters;
  }, [distanceMeters]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    const unsubscribeConnection = WorkoutBroadcast.subscribeConnection(setConnection);
    const unsubscribeControls = WorkoutBroadcast.subscribeControls(async ({ action }) => {
      if (action === 'start') {
        await handleStart();
      }
      if (action === 'pause') {
        handlePause();
      }
      if (action === 'stop') {
        handleStop();
      }
    });

    return () => {
      unsubscribeConnection();
      unsubscribeControls();
    };
  }, []);

  useEffect(() => {
    return () => {
      WorkoutBroadcast.stop();
      if (watchRef.current) {
        watchRef.current.remove();
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  const distanceMiles = useMemo(() => metersToMiles(distanceMeters), [distanceMeters]);

  const pace = useMemo(() => {
    if (!distanceMiles || !elapsed) return '0:00';
    const paceMin = elapsed / 60 / distanceMiles;
    const minutes = Math.floor(paceMin);
    const seconds = Math.round((paceMin - minutes) * 60);
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }, [elapsed, distanceMiles]);

  useEffect(() => {
    paceRef.current = pace;
  }, [pace]);

  const getBroadcastPayload = () => {
    const miles = metersToMiles(distanceRef.current);
    return {
      status: statusRef.current,
      pace: paceRef.current,
      distance: miles,
      distanceMiles: miles,
      elapsed: elapsedRef.current,
      heartRate: null
    };
  };

  const startBroadcast = async () => {
    await WorkoutBroadcast.start({
      workoutType: 'run',
      getPayload: getBroadcastPayload
    });
  };

  const stopBroadcast = () => {
    WorkoutBroadcast.stop();
  };

  const startTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
  };

  const startTracking = async () => {
    const { status: permissionStatus } = await Location.requestForegroundPermissionsAsync();
    if (permissionStatus !== 'granted') {
      Alert.alert('Location Required', 'Location permission is required to track a run.');
      return false;
    }

    watchRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.Highest,
        timeInterval: 3000,
        distanceInterval: 2
      },
      (location) => {
        const next = location.coords;
        const prev = previousCoordsRef.current;

        if (prev) {
          const increment = calcDistanceMeters(prev, next);
          if (increment > 0 && increment < 120) {
            setDistanceMeters((d) => d + increment);
          }
        }

        previousCoordsRef.current = next;
      }
    );
    return true;
  };

  const handleStart = async () => {
    if (statusRef.current === 'running') return;

    if (statusRef.current === 'idle') {
      setDistanceMeters(0);
      setElapsed(0);
      previousCoordsRef.current = null;
      const trackingStarted = await startTracking();
      if (!trackingStarted) return;
    }

    if (statusRef.current === 'paused') {
      const trackingStarted = await startTracking();
      if (!trackingStarted) return;
    }

    startTimer();
    setStatus('running');
    statusRef.current = 'running';
    await startBroadcast();
  };

  const handlePause = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (watchRef.current) {
      watchRef.current.remove();
      watchRef.current = null;
    }
    setStatus('paused');
    statusRef.current = 'paused';
    stopBroadcast();
  };

  const handleStop = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (watchRef.current) {
      watchRef.current.remove();
      watchRef.current = null;
    }
    setStatus('stopped');
    statusRef.current = 'stopped';
    stopBroadcast();
  };

  const handleSave = async () => {
    if (!elapsed || !distanceMiles) {
      Alert.alert('Not Enough Data', 'Track a run before saving.');
      return;
    }

    const run = {
      distance: Number(distanceMiles.toFixed(2)),
      duration: elapsed,
      pace,
      calories: Math.round(distanceMiles * 100),
      date: new Date().toISOString()
    };

    try {
      setSaving(true);
      stopBroadcast();
      await api.post('/runs', run);
      try {
        await syncRunToHealth(run);
      } catch {
        // Health sync failure should not block run save.
      }
      Alert.alert('Saved', 'Run logged successfully.');
      setStatus('idle');
      statusRef.current = 'idle';
      setElapsed(0);
      setDistanceMeters(0);
    } catch (error) {
      Alert.alert('Save Failed', error?.response?.data?.message || 'Unable to save run.');
    } finally {
      setSaving(false);
    }
  };

  const isWatchReachable = Boolean(connection?.reachable || connection?.connected);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View style={styles.headerTextWrap}>
          <Text style={styles.title}>Log Run</Text>
          <Text style={styles.subtitle}>Track distance, pace, and duration in real time.</Text>
        </View>

        <View style={[styles.watchBadge, isWatchReachable ? styles.watchBadgeActive : null]}>
          <Watch size={14} color={isWatchReachable ? COLORS.accent : COLORS.subtext} />
          <Text style={[styles.watchBadgeText, isWatchReachable ? styles.watchBadgeTextActive : null]}>
            {isWatchReachable ? 'Watch On' : 'Watch Off'}
          </Text>
        </View>
      </View>

      <View style={styles.metricCard}>
        <Text style={styles.metricHeading}>Distance</Text>
        <Text style={styles.distanceValue}>{distanceMiles.toFixed(2)} mi</Text>

        <View style={styles.metricsRow}>
          <View style={styles.metricCol}>
            <Text style={styles.metricLabel}>Duration</Text>
            <Text style={styles.metricValue}>{formatDuration(elapsed)}</Text>
          </View>
          <View style={styles.metricCol}>
            <Text style={styles.metricLabel}>Pace</Text>
            <Text style={styles.metricValue}>{pace} /mi</Text>
          </View>
          <View style={styles.metricCol}>
            <Text style={styles.metricLabel}>Status</Text>
            <Text style={styles.metricValue}>{status}</Text>
          </View>
        </View>
      </View>

      <View style={styles.actionsGrid}>
        <Pressable onPress={handleStart} style={styles.primaryButton}>
          <Play color={COLORS.background} size={18} />
          <Text style={styles.primaryButtonText}>{status === 'paused' ? 'Resume' : 'Start'}</Text>
        </Pressable>

        <Pressable onPress={handlePause} disabled={status !== 'running'} style={[styles.secondaryButton, status !== 'running' && styles.disabledButton]}>
          <Pause color={COLORS.text} size={18} />
          <Text style={styles.secondaryButtonText}>Pause</Text>
        </Pressable>

        <Pressable onPress={handleStop} disabled={status === 'idle'} style={[styles.secondaryButton, status === 'idle' && styles.disabledButton]}>
          <Square color={COLORS.text} size={18} />
          <Text style={styles.secondaryButtonText}>Stop</Text>
        </Pressable>

        <Pressable onPress={handleSave} disabled={saving} style={[styles.outlineAccentButton, saving && styles.disabledButton]}>
          <Save color={COLORS.accent} size={18} />
          <Text style={styles.outlineAccentButtonText}>{saving ? 'Saving...' : 'Save Run'}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 24
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start'
  },
  headerTextWrap: {
    flex: 1,
    paddingRight: 10
  },
  title: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: '700'
  },
  subtitle: {
    color: COLORS.subtext,
    fontSize: 15,
    marginTop: 4
  },
  watchBadge: {
    marginTop: 3,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 999,
    borderColor: COLORS.border,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6
  },
  watchBadgeActive: {
    borderColor: COLORS.accent
  },
  watchBadgeText: {
    color: COLORS.subtext,
    marginLeft: 5,
    fontSize: 12,
    fontWeight: '600'
  },
  watchBadgeTextActive: {
    color: COLORS.accent
  },
  metricCard: {
    marginTop: 18,
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 18
  },
  metricHeading: {
    color: COLORS.subtext,
    fontSize: 13
  },
  distanceValue: {
    color: COLORS.accent,
    fontSize: 40,
    fontWeight: '700',
    marginTop: 6
  },
  metricsRow: {
    marginTop: 14,
    flexDirection: 'row',
    justifyContent: 'space-between'
  },
  metricCol: {
    width: '31%'
  },
  metricLabel: {
    color: COLORS.subtext,
    fontSize: 12,
    textTransform: 'uppercase'
  },
  metricValue: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '600',
    marginTop: 4
  },
  actionsGrid: {
    marginTop: 14,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between'
  },
  primaryButton: {
    width: '48.5%',
    marginBottom: 10,
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 13,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row'
  },
  primaryButtonText: {
    color: COLORS.background,
    fontWeight: '700',
    marginLeft: 8
  },
  secondaryButton: {
    width: '48.5%',
    marginBottom: 10,
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 13,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row'
  },
  secondaryButtonText: {
    color: COLORS.text,
    fontWeight: '600',
    marginLeft: 8
  },
  outlineAccentButton: {
    width: '48.5%',
    marginBottom: 10,
    backgroundColor: COLORS.card,
    borderColor: COLORS.accent,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 13,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row'
  },
  outlineAccentButtonText: {
    color: COLORS.accent,
    fontWeight: '600',
    marginLeft: 8
  },
  disabledButton: {
    opacity: 0.45
  }
});
