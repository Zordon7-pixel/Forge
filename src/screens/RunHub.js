import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api from '../lib/api';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
  success: '#22c55e',
  error: '#ef4444',
  input: '#1e2433'
};

const getDistance = (run) => Number(run?.distance_miles ?? run?.distance ?? 0);
const getDuration = (run) => Number(run?.duration_seconds ?? run?.duration ?? 0);

const formatPace = (seconds, miles) => {
  if (!seconds || !miles) return '--';
  const pace = seconds / 60 / miles;
  const mins = Math.floor(pace);
  const secs = Math.round((pace - mins) * 60);
  return `${mins}:${String(secs).padStart(2, '0')} /mi`;
};

const getPaceZone = (paceMinPerMile) => {
  if (paceMinPerMile < 7) return { zone: 5, label: 'Max Effort', color: '#ef4444' };
  if (paceMinPerMile < 8.5) return { zone: 4, label: 'Threshold', color: '#f97316' };
  if (paceMinPerMile < 10) return { zone: 3, label: 'Tempo', color: '#EAB308' };
  if (paceMinPerMile <= 12) {
    return {
      zone: 2,
      label: 'Moderate',
      color: '#22c55e',
      detail: 'steady aerobic work - improves endurance efficiency'
    };
  }
  return { zone: 1, label: 'Recovery', color: '#94a3b8' };
};

export default function RunHub({ navigation }) {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [latestRun, setLatestRun] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/runs').catch(() => ({ data: [] }));
      const runs = Array.isArray(res?.data) ? res.data : res?.data?.runs || [];
      setLatestRun(runs[0] || null);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const pace = useMemo(() => {
    if (!latestRun) return '--';
    return formatPace(getDuration(latestRun), getDistance(latestRun));
  }, [latestRun]);

  const zone = useMemo(() => {
    if (!latestRun) return null;
    const distance = getDistance(latestRun);
    const duration = getDuration(latestRun);
    if (!distance || !duration) return null;
    return getPaceZone(duration / 60 / distance);
  }, [latestRun]);

  return (
    <ScrollView style={[styles.container, { paddingTop: insets.top }]} contentContainerStyle={styles.content}>
      <View style={styles.headerCard}>
        <Text style={styles.title}>Run Hub</Text>
        <Text style={styles.subtitle}>Your last run translated into runner language.</Text>
      </View>

      <View style={styles.card}>
        {loading ? (
          <Text style={styles.muted}>Loading run stats...</Text>
        ) : !latestRun ? (
          <Text style={styles.muted}>No runs yet. Log one to see your pace zone.</Text>
        ) : (
          <>
            <Text style={styles.muted}>Latest Pace</Text>
            <Text style={styles.paceText}>
              {pace}
              {zone ? <Text style={{ color: zone.color }}> · Zone {zone.zone} {zone.label}</Text> : null}
            </Text>
            {zone?.detail ? <Text style={[styles.zoneDetail, { color: zone.color }]}>{zone.detail}</Text> : null}
          </>
        )}
      </View>

      <Pressable onPress={() => navigation.navigate('LogRun')} style={styles.ctaButton}>
        <Text style={styles.ctaButtonText}>Open Run Logger</Text>
      </Pressable>
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
    paddingTop: 16,
    paddingBottom: 24
  },
  headerCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    backgroundColor: COLORS.card,
    padding: 16,
    marginBottom: 12
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
  card: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    backgroundColor: COLORS.card,
    padding: 16,
    marginBottom: 12
  },
  muted: {
    color: COLORS.subtext,
    fontSize: 13
  },
  paceText: {
    color: COLORS.text,
    fontSize: 19,
    fontWeight: '700',
    marginTop: 6
  },
  zoneDetail: {
    marginTop: 8,
    fontSize: 12
  },
  ctaButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center'
  },
  ctaButtonText: {
    color: '#000000',
    fontSize: 15,
    fontWeight: '700'
  }
});
