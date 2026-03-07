import { useSafeAreaInsets } from 'react-native-safe-area-context';
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

const HR_ZONES = [
  { key: 'Z1', min: 0.5, max: 0.6, color: '#6B7280', label: 'Recovery' },
  { key: 'Z2', min: 0.6, max: 0.7, color: '#3B82F6', label: 'Aerobic' },
  { key: 'Z3', min: 0.7, max: 0.8, color: '#22C55E', label: 'Tempo' },
  { key: 'Z4', min: 0.8, max: 0.9, color: '#EAB308', label: 'Threshold' },
  { key: 'Z5', min: 0.9, max: 1.01, color: '#EF4444', label: 'Max' },
];

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

const getHrZone = (heartRate, age) => {
  const hr = Number(heartRate);
  const maxHr = 220 - Number(age);
  if (!hr || !maxHr || maxHr <= 0) return null;
  const pct = hr / maxHr;
  const zone = HR_ZONES.find((item) => pct >= item.min && pct < item.max) || HR_ZONES[HR_ZONES.length - 1];
  return { ...zone, pct, maxHr };
};

export default function ActiveRun() {
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState('idle');
  const [elapsed, setElapsed] = useState(0);
  const [distanceMeters, setDistanceMeters] = useState(0);
  const [saving, setSaving] = useState(false);
  const [connection, setConnection] = useState(WorkoutBroadcast.getConnectionState());
  const [userAge, setUserAge] = useState(null);
  const [heartRate, setHeartRate] = useState(null);

  const watchRef = useRef(null);
  const timerRef = useRef(null);
  const previousCoordsRef = useRef(null);

  const elapsedRef = useRef(0);
  const distanceRef = useRef(0);
  const paceRef = useRef('0:00');
  const statusRef = useRef('idle');

  useEffect(() => {
    api.get('/auth/me')
      .then((response) => {
        const user = response?.data?.user || response?.data || {};
        setUserAge(Number(user?.age) || null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (status !== 'running') return undefined;

    const pollHeartRate = async () => {
      try {
        const response = await api.get('/watch-sync/status');
        const hr = response?.data?.avg_heart_rate || response?.data?.heart_rate || response?.data?.current_heart_rate;
        setHeartRate(Number(hr) || null);
      } catch {
        // Non-blocking: HR data is optional.
      }
    };

    pollHeartRate();
    const interval = setInterval(pollHeartRate, 5000);
    return () => clearInterval(interval);
  }, [status]);

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

  const hrZone = useMemo(() => getHrZone(heartRate, userAge), [heartRate, userAge]);

  const getBroadcastPayload = () => {
    const miles = metersToMiles(distanceRef.current);
    return {
      status: statusRef.current,
      pace: paceRef.current,
      distance: miles,
      distanceMiles: miles,
      elapsed: elapsedRef.current,
      heartRate: heartRate || null,
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
      date: new Date().toISOString(),
      avg_heart_rate: heartRate || undefined,
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
      setHeartRate(null);
    } catch (error) {
      Alert.alert('Save Failed', error?.response?.data?.message || 'Unable to save run.');
    } finally {
      setSaving(false);
    }
  };

  const isWatchReachable = Boolean(connection?.reachable || connection?.connected);

  return (
    <ScrollView style={[styles.container, { paddingTop: insets.top }]} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View style={styles.headerTextWrap}>
          <Text style={styles.title}>Active Run</Text>
          <Text style={styles.subtitle}>Track distance, pace, duration, and HR zones.</Text>
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

        {heartRate ? (
          <View style={styles.hrCard}>
            <Text style={styles.hrLabel}>Heart Rate</Text>
            <View style={styles.hrRow}>
              <Text style={styles.hrValue}>{heartRate} bpm</Text>
              {hrZone ? (
                <View style={[styles.zonePill, { backgroundColor: `${hrZone.color}22` }]}>
                  <Text style={[styles.zonePillText, { color: hrZone.color }]}>{hrZone.key}</Text>
                </View>
              ) : null}
            </View>
            {hrZone ? (
              <Text style={[styles.hrZoneText, { color: hrZone.color }]}>Zone {hrZone.key.slice(1)} · {hrZone.label} ({Math.round(hrZone.pct * 100)}% max)</Text>
            ) : (
              <Text style={styles.hrHint}>Set your age in profile for HR zones.</Text>
            )}
          </View>
        ) : (
          <Text style={styles.hrHint}>Connect watch sync for live heart rate and zones.</Text>
        )}
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
    paddingTop: 12,
    paddingBottom: 30,
    gap: 12
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12
  },
  headerTextWrap: {
    flex: 1
  },
  title: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '800'
  },
  subtitle: {
    color: COLORS.subtext,
    fontSize: 13,
    marginTop: 4
  },
  watchBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: COLORS.card
  },
  watchBadgeActive: {
    borderColor: '#4b5563'
  },
  watchBadgeText: {
    color: COLORS.subtext,
    fontSize: 11,
    fontWeight: '700'
  },
  watchBadgeTextActive: {
    color: COLORS.accent
  },
  metricCard: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    padding: 16
  },
  metricHeading: {
    color: COLORS.subtext,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.8
  },
  distanceValue: {
    color: COLORS.accent,
    fontSize: 34,
    fontWeight: '900',
    marginTop: 2
  },
  metricsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14
  },
  metricCol: {
    flex: 1,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 10,
    alignItems: 'center'
  },
  metricLabel: {
    color: COLORS.subtext,
    fontSize: 11,
    textTransform: 'uppercase'
  },
  metricValue: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700',
    marginTop: 3
  },
  hrCard: {
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: '#111827',
    padding: 12,
  },
  hrLabel: {
    color: COLORS.subtext,
    fontSize: 11,
    textTransform: 'uppercase',
  },
  hrRow: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  hrValue: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: '800',
  },
  zonePill: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  zonePillText: {
    fontSize: 11,
    fontWeight: '700',
  },
  hrZoneText: {
    fontSize: 12,
    marginTop: 6,
    fontWeight: '700',
  },
  hrHint: {
    color: COLORS.subtext,
    fontSize: 12,
    marginTop: 8,
  },
  actionsGrid: {
    gap: 10
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 13
  },
  primaryButtonText: {
    color: COLORS.background,
    fontWeight: '800',
    fontSize: 14
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.card,
    borderRadius: 12,
    paddingVertical: 13,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  secondaryButtonText: {
    color: COLORS.text,
    fontWeight: '700',
    fontSize: 14
  },
  outlineAccentButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.card,
    borderRadius: 12,
    paddingVertical: 13,
    borderWidth: 1,
    borderColor: COLORS.accent
  },
  outlineAccentButtonText: {
    color: COLORS.accent,
    fontWeight: '800',
    fontSize: 14
  },
  disabledButton: {
    opacity: 0.55
  }
});
