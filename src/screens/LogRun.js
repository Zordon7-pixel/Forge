import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { Pause, Play, Save, Square } from 'lucide-react-native';

import api from '../lib/api';
import { syncRunToHealth } from '../lib/health';

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

export default function LogRun() {
  const [status, setStatus] = useState('idle');
  const [elapsed, setElapsed] = useState(0);
  const [distanceMeters, setDistanceMeters] = useState(0);
  const [saving, setSaving] = useState(false);
  const watchRef = useRef(null);
  const timerRef = useRef(null);
  const previousCoordsRef = useRef(null);

  useEffect(() => {
    return () => {
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
    if (status === 'running') return;

    if (status === 'idle') {
      setDistanceMeters(0);
      setElapsed(0);
      previousCoordsRef.current = null;
      const trackingStarted = await startTracking();
      if (!trackingStarted) return;
    }

    if (status === 'paused') {
      const trackingStarted = await startTracking();
      if (!trackingStarted) return;
    }

    startTimer();
    setStatus('running');
  };

  const handlePause = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (watchRef.current) {
      watchRef.current.remove();
      watchRef.current = null;
    }
    setStatus('paused');
  };

  const handleStop = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (watchRef.current) {
      watchRef.current.remove();
      watchRef.current = null;
    }
    setStatus('stopped');
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
      await api.post('/runs', run);
      try {
        await syncRunToHealth(run);
      } catch {
        // Health sync failure should not block run save.
      }
      Alert.alert('Saved', 'Run logged successfully.');
      setStatus('idle');
      setElapsed(0);
      setDistanceMeters(0);
    } catch (error) {
      Alert.alert('Save Failed', error?.response?.data?.message || 'Unable to save run.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView className="flex-1 bg-forge-bg px-4 pt-6">
      <Text className="text-2xl font-bold text-forge-text">Log Run</Text>
      <Text className="mt-1 text-forge-subtext">Track distance, pace, and duration in real time.</Text>

      <View className="mt-6 rounded-2xl border border-forge-border bg-forge-card p-5">
        <Text className="text-sm text-forge-subtext">Distance</Text>
        <Text className="mt-2 text-4xl font-semibold text-forge-accent">{distanceMiles.toFixed(2)} mi</Text>

        <View className="mt-4 flex-row justify-between">
          <View>
            <Text className="text-xs text-forge-subtext">Duration</Text>
            <Text className="mt-1 text-lg font-medium text-forge-text">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</Text>
          </View>
          <View>
            <Text className="text-xs text-forge-subtext">Pace</Text>
            <Text className="mt-1 text-lg font-medium text-forge-text">{pace} /mi</Text>
          </View>
          <View>
            <Text className="text-xs text-forge-subtext">Status</Text>
            <Text className="mt-1 text-lg font-medium text-forge-text capitalize">{status}</Text>
          </View>
        </View>
      </View>

      <View className="mt-5 flex-row flex-wrap gap-3">
        <Pressable onPress={handleStart} className="min-w-[47%] flex-row items-center justify-center gap-2 rounded-xl bg-forge-accent px-4 py-3">
          <Play color="#0f1117" size={18} />
          <Text className="font-semibold text-black">{status === 'paused' ? 'Resume' : 'Start'}</Text>
        </Pressable>

        <Pressable onPress={handlePause} disabled={status !== 'running'} className="min-w-[47%] flex-row items-center justify-center gap-2 rounded-xl border border-forge-border bg-forge-card px-4 py-3">
          <Pause color="#FFFFFF" size={18} />
          <Text className="font-semibold text-forge-text">Pause</Text>
        </Pressable>

        <Pressable onPress={handleStop} disabled={status === 'idle'} className="min-w-[47%] flex-row items-center justify-center gap-2 rounded-xl border border-forge-border bg-forge-card px-4 py-3">
          <Square color="#FFFFFF" size={18} />
          <Text className="font-semibold text-forge-text">Stop</Text>
        </Pressable>

        <Pressable onPress={handleSave} disabled={saving} className="min-w-[47%] flex-row items-center justify-center gap-2 rounded-xl border border-forge-accent bg-forge-card px-4 py-3">
          <Save color="#EAB308" size={18} />
          <Text className="font-semibold text-forge-accent">{saving ? 'Saving...' : 'Save Run'}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
