import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Pause, Play, Save, Square } from 'lucide-react-native';

import api from '../lib/api';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
  success: '#22c55e',
};

const formatDuration = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export default function TreadmillRun({ navigation }) {
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState('idle');
  const [elapsed, setElapsed] = useState(0);
  const [speed, setSpeed] = useState('');
  const [incline, setIncline] = useState('0');
  const [distance, setDistance] = useState('');
  const [saving, setSaving] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const estimatedDistance = useMemo(() => {
    const speedNum = Number(speed);
    if (!speedNum || elapsed <= 0) return '';
    return ((speedNum * elapsed) / 3600).toFixed(2);
  }, [elapsed, speed]);

  const livePace = useMemo(() => {
    const speedNum = Number(speed);
    if (!speedNum) return '--';
    const minutesPerMile = 60 / speedNum;
    const mins = Math.floor(minutesPerMile);
    const secs = Math.round((minutesPerMile - mins) * 60);
    return `${mins}:${String(secs).padStart(2, '0')}/mi`;
  }, [speed]);

  const startTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
  };

  const onStart = () => {
    startTimer();
    setStatus('running');
  };

  const onPause = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setStatus('paused');
  };

  const onStop = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setStatus('done');
  };

  const onSave = async () => {
    const finalDistance = Number(distance || estimatedDistance);
    if (!finalDistance || finalDistance <= 0 || elapsed <= 0) {
      Alert.alert('Missing Data', 'Add distance and track some duration before saving.');
      return;
    }

    const payload = {
      date: new Date().toISOString().slice(0, 10),
      type: 'treadmill',
      source: 'treadmill',
      run_surface: 'treadmill',
      distance_miles: finalDistance,
      duration_seconds: elapsed,
      treadmill_speed: Number(speed) || 0,
      incline_pct: Number(incline) || 0,
      notes: `Treadmill run | ${speed || '?'} mph @ ${incline || 0}% incline`,
    };

    try {
      setSaving(true);
      await api.post('/runs', payload);
      Alert.alert('Saved', 'Treadmill run logged.');
      navigation.goBack();
    } catch (error) {
      Alert.alert('Save Failed', error?.response?.data?.message || 'Unable to save treadmill run.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView style={[styles.container, { paddingTop: insets.top }]} contentContainerStyle={styles.content}>
      <View style={styles.heroCard}>
        <Text style={styles.title}>Treadmill Run</Text>
        <Text style={styles.subtitle}>Track incline, speed, and auto-calculate distance.</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Speed (mph)</Text>
        <TextInput
          value={speed}
          onChangeText={setSpeed}
          placeholder="6.5"
          placeholderTextColor={COLORS.subtext}
          keyboardType="decimal-pad"
          style={styles.input}
        />

        <Text style={styles.label}>Incline (%)</Text>
        <TextInput
          value={incline}
          onChangeText={setIncline}
          placeholder="0"
          placeholderTextColor={COLORS.subtext}
          keyboardType="decimal-pad"
          style={styles.input}
        />

        <View style={styles.metricsRow}>
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>Duration</Text>
            <Text style={styles.metricValue}>{formatDuration(elapsed)}</Text>
          </View>
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>Pace</Text>
            <Text style={styles.metricValue}>{livePace}</Text>
          </View>
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>Distance</Text>
            <Text style={styles.metricValue}>{estimatedDistance || '--'} mi</Text>
          </View>
        </View>
      </View>

      <View style={styles.actions}>
        {status === 'running' ? (
          <Pressable style={styles.secondaryButton} onPress={onPause}>
            <Pause color={COLORS.text} size={16} />
            <Text style={styles.secondaryButtonText}>Pause</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.primaryButton} onPress={onStart}>
            <Play color="#000" size={16} />
            <Text style={styles.primaryButtonText}>{status === 'paused' ? 'Resume' : 'Start'}</Text>
          </Pressable>
        )}

        <Pressable style={styles.stopButton} onPress={onStop} disabled={status === 'idle'}>
          <Square color={COLORS.text} size={16} />
          <Text style={styles.secondaryButtonText}>Finish</Text>
        </Pressable>
      </View>

      {status === 'done' ? (
        <View style={styles.card}>
          <Text style={styles.label}>Distance (mi)</Text>
          <TextInput
            value={distance}
            onChangeText={setDistance}
            placeholder={estimatedDistance ? `Estimated ${estimatedDistance}` : 'Enter distance'}
            placeholderTextColor={COLORS.subtext}
            keyboardType="decimal-pad"
            style={styles.input}
          />
          {estimatedDistance && !distance ? (
            <Pressable onPress={() => setDistance(estimatedDistance)}>
              <Text style={styles.useEstimate}>Use estimated distance</Text>
            </Pressable>
          ) : null}

          <Pressable style={styles.saveButton} onPress={onSave} disabled={saving}>
            <Save color="#000" size={16} />
            <Text style={styles.saveButtonText}>{saving ? 'Saving...' : 'Save Run'}</Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 32,
  },
  heroCard: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  title: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '900',
  },
  subtitle: {
    color: COLORS.subtext,
    fontSize: 13,
    marginTop: 4,
  },
  card: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
  },
  label: {
    color: COLORS.subtext,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
    marginTop: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: '#111827',
    borderRadius: 10,
    color: COLORS.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  metricsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
  },
  metricBox: {
    flex: 1,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    backgroundColor: '#111827',
    padding: 10,
    alignItems: 'center',
  },
  metricLabel: {
    color: COLORS.subtext,
    fontSize: 11,
  },
  metricValue: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700',
    marginTop: 3,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  primaryButton: {
    flex: 1,
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
    paddingVertical: 12,
  },
  primaryButtonText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '800',
  },
  secondaryButton: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
    paddingVertical: 12,
  },
  stopButton: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
    paddingVertical: 12,
    backgroundColor: '#1f2937',
  },
  secondaryButtonText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700',
  },
  useEstimate: {
    color: COLORS.accent,
    fontSize: 12,
    marginTop: 8,
    fontWeight: '700',
  },
  saveButton: {
    marginTop: 12,
    borderRadius: 12,
    backgroundColor: COLORS.success,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
    paddingVertical: 12,
  },
  saveButtonText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '800',
  },
});
