import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api from '../lib/api';
import AppHeader from '../components/AppHeader';

// ─── Colors (FORGE design system) ───────────────────────────────────────────
const C = {
  bg:     '#0d1117',
  card:   '#161b22',
  accent: '#eab308',
  text:   '#ffffff',
  muted:  '#8b949e',
  border: '#21262d',
  green:  '#22c55e',
  red:    '#ef4444',
  input:  '#0d1117',
};

// ─── Pace zones — matches web athleteLanguage.js exactly ────────────────────
const PACE_ZONES = [
  { zone: 1, label: 'Easy',      description: 'Conversational pace — builds aerobic base',           color: '#4CAF50' },
  { zone: 2, label: 'Moderate',  description: 'Steady aerobic work — improves endurance efficiency', color: '#8BC34A' },
  { zone: 3, label: 'Tempo',     description: 'Comfortably hard — strengthens sustained speed',      color: '#FFC107' },
  { zone: 4, label: 'Threshold', description: 'Controlled discomfort — raises lactate threshold',    color: '#FF9800' },
  { zone: 5, label: 'Race Pace', description: 'High intensity effort — race-specific speed',         color: '#F44336' },
];

function getPaceZone(paceMinPerMile) {
  const pace = Number(paceMinPerMile);
  if (!pace || pace <= 0) return null;
  if (pace > 10.5) return PACE_ZONES[0];
  if (pace >= 9 && pace <= 10.5) return PACE_ZONES[1];
  if (pace >= 7.5 && pace < 9)   return PACE_ZONES[2];
  if (pace >= 6.5 && pace < 7.5) return PACE_ZONES[3];
  return PACE_ZONES[4];
}

function getDistance(run)  { return Number(run?.distance_miles ?? run?.distance ?? 0); }
function getDuration(run)  { return Number(run?.duration_seconds ?? run?.duration ?? 0); }

function formatPace(seconds, miles) {
  if (!seconds || !miles) return '--';
  const pace = seconds / 60 / miles;
  const mins = Math.floor(pace);
  const secs = Math.round((pace - mins) * 60);
  return `${mins}:${String(secs).padStart(2, '0')} /mi`;
}

function formatDistance(miles) {
  return miles ? `${Number(miles).toFixed(2)} mi` : '--';
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds || 0)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// ─── Component ───────────────────────────────────────────────────────────────
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

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const paceZone = useMemo(() => {
    if (!latestRun) return null;
    const dist = getDistance(latestRun);
    const dur  = getDuration(latestRun);
    if (!dist || !dur) return null;
    return getPaceZone(dur / 60 / dist);
  }, [latestRun]);

  const paceText = useMemo(() => {
    if (!latestRun) return '--';
    return formatPace(getDuration(latestRun), getDistance(latestRun));
  }, [latestRun]);

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={styles.content}
    >
      <AppHeader />

      {/* Header card */}
      <View style={styles.card}>
        <Text style={styles.title}>Run Hub</Text>
        <Text style={styles.subtitle}>Your last run translated into runner language.</Text>
      </View>

      {/* Pace zone card */}
      <View style={styles.card}>
        {loading ? (
          <Text style={styles.muted}>Loading run stats…</Text>
        ) : !latestRun ? (
          <Text style={styles.muted}>No runs yet. Log one to see your pace zone.</Text>
        ) : (
          <>
            <Text style={styles.statLabel}>Latest Pace</Text>
            <Text style={styles.paceText}>
              {paceText}
              {paceZone ? (
                <Text style={{ color: paceZone.color }}>
                  {' '}· Zone {paceZone.zone} {paceZone.label}
                </Text>
              ) : null}
            </Text>
            {paceZone ? (
              <Text style={[styles.zoneDesc, { color: paceZone.color }]}>
                {paceZone.description}
              </Text>
            ) : null}

            {/* Quick stats row */}
            <View style={styles.statsRow}>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>{formatDistance(getDistance(latestRun))}</Text>
                <Text style={styles.statKey}>Distance</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>{formatDuration(getDuration(latestRun))}</Text>
                <Text style={styles.statKey}>Duration</Text>
              </View>
              {latestRun.date ? (
                <View style={styles.statBox}>
                  <Text style={styles.statValue}>
                    {new Date(`${latestRun.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </Text>
                  <Text style={styles.statKey}>Date</Text>
                </View>
              ) : null}
            </View>
          </>
        )}
      </View>

      {/* CTA */}
      <Pressable
        onPress={() => navigation.navigate('LogRun')}
        style={({ pressed }) => [styles.ctaButton, pressed && { opacity: 0.85 }]}
      >
        <Text style={styles.ctaText}>Open Run Logger</Text>
      </Pressable>
    </ScrollView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.bg,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 32,
  },
  card: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  title: {
    color: C.text,
    fontSize: 26,
    fontWeight: '800',
    marginBottom: 4,
  },
  subtitle: {
    color: C.muted,
    fontSize: 13,
  },
  statLabel: {
    color: C.muted,
    fontSize: 12,
    marginBottom: 4,
  },
  paceText: {
    color: C.text,
    fontSize: 20,
    fontWeight: '700',
  },
  zoneDesc: {
    fontSize: 13,
    marginTop: 8,
    lineHeight: 18,
  },
  statsRow: {
    flexDirection: 'row',
    marginTop: 16,
    gap: 8,
  },
  statBox: {
    flex: 1,
    backgroundColor: C.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    padding: 10,
    alignItems: 'center',
  },
  statValue: {
    color: C.text,
    fontSize: 14,
    fontWeight: '700',
  },
  statKey: {
    color: C.muted,
    fontSize: 11,
    marginTop: 2,
  },
  ctaButton: {
    backgroundColor: C.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  ctaText: {
    color: '#000000',
    fontSize: 15,
    fontWeight: '700',
  },
});
