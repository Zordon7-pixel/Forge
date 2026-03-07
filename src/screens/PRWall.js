import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Trophy } from 'lucide-react-native';

import api from '../lib/api';
import AppHeader from '../components/AppHeader';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
};

const RUN_LABELS = ['5K PR', '10K PR', 'Half Marathon PR', 'Marathon PR'];

const formatValue = (pr) => {
  const value = Number(pr?.value ?? 0);
  const unit = String(pr?.unit || '').toLowerCase();
  if (!value) return '--';
  if (unit === 'min/mi') {
    const mins = Math.floor(value);
    const secs = Math.round((value - mins) * 60);
    return `${mins}:${String(secs).padStart(2, '0')} /mi`;
  }
  if (unit === 'mi') return `${value.toFixed(2)} mi`;
  if (unit === 'lbs' || unit === 'lb') return `${Math.round(value)} lbs`;
  if (unit === 'reps') return `${Math.round(value)} reps`;
  return `${value} ${pr?.unit || ''}`.trim();
};

export default function PRWall() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [prs, setPrs] = useState([]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const response = await api.get('/prs');
      const list = Array.isArray(response?.data)
        ? response.data
        : response?.data?.prs || [];
      setPrs(list);
    } catch (loadError) {
      setError(loadError?.response?.data?.error || 'Could not load PR wall right now.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const runPRs = useMemo(() => prs.filter((pr) => pr.category === 'run'), [prs]);
  const liftPRs = useMemo(() => prs.filter((pr) => pr.category === 'lift'), [prs]);

  const runCards = useMemo(() => {
    return RUN_LABELS.map((label) => runPRs.find((pr) => pr.label === label) || { label, value: 0, unit: '' });
  }, [runPRs]);

  const timeline = useMemo(() => {
    return [...prs]
      .filter((pr) => pr?.achieved_at)
      .sort((a, b) => new Date(b.achieved_at) - new Date(a.achieved_at));
  }, [prs]);

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl tintColor={COLORS.accent} refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} />}
    >
      <AppHeader />

      <View style={styles.heroCard}>
        <Text style={styles.title}>PR Wall</Text>
        <Text style={styles.subtitle}>Your best run and lift performances, all in one place.</Text>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={COLORS.accent} />
          <Text style={styles.loadingText}>Loading records...</Text>
        </View>
      ) : null}

      {!loading && !!error ? (
        <View style={styles.errorCard}><Text style={styles.errorText}>{error}</Text></View>
      ) : null}

      {!loading && !error && prs.length === 0 ? (
        <View style={styles.card}>
          <Trophy color={COLORS.subtext} size={20} />
          <Text style={styles.emptyTitle}>No PRs Yet</Text>
          <Text style={styles.emptyBody}>Log runs and lifts to start filling your wall.</Text>
        </View>
      ) : null}

      {!loading && !error && prs.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>Run PRs</Text>
          {runCards.map((pr) => (
            <View key={pr.label} style={styles.cardRow}>
              <View>
                <Text style={styles.rowLabel}>{pr.label}</Text>
                <Text style={styles.rowDate}>{pr?.achieved_at ? new Date(pr.achieved_at).toLocaleDateString() : 'No result yet'}</Text>
              </View>
              <Text style={styles.rowValue}>{formatValue(pr)}</Text>
            </View>
          ))}

          <Text style={styles.sectionTitle}>Lift PRs</Text>
          {liftPRs.length === 0 ? (
            <View style={styles.cardRow}><Text style={styles.emptyBody}>No lift PRs yet.</Text></View>
          ) : (
            liftPRs.map((pr, idx) => (
              <View key={pr.id || `lift-${idx}`} style={styles.cardRow}>
                <View>
                  <Text style={styles.rowLabel}>{pr.label || 'Lift PR'}</Text>
                  <Text style={styles.rowDate}>{pr?.achieved_at ? new Date(pr.achieved_at).toLocaleDateString() : '--'}</Text>
                </View>
                <Text style={styles.rowValue}>{formatValue(pr)}</Text>
              </View>
            ))
          )}

          <Text style={styles.sectionTitle}>Timeline</Text>
          {timeline.map((pr, idx) => (
            <View key={pr.id || `timeline-${idx}`} style={styles.timelineRow}>
              <View style={styles.dot} />
              <View style={{ flex: 1 }}>
                <Text style={styles.timelineTitle}>{pr.label || 'PR'}</Text>
                <Text style={styles.timelineSub}>{new Date(pr.achieved_at).toLocaleDateString()} · {formatValue(pr)}</Text>
              </View>
            </View>
          ))}
        </>
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
    paddingBottom: 30,
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
  loadingWrap: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
    gap: 8,
  },
  loadingText: {
    color: COLORS.subtext,
    fontSize: 13,
  },
  errorCard: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: '#7f1d1d',
    borderRadius: 14,
    padding: 14,
  },
  errorText: {
    color: '#fca5a5',
    fontSize: 13,
  },
  card: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    padding: 18,
    alignItems: 'center',
    gap: 8,
  },
  emptyTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '800',
  },
  emptyBody: {
    color: COLORS.subtext,
    fontSize: 13,
  },
  sectionTitle: {
    color: COLORS.subtext,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontSize: 11,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 8,
  },
  cardRow: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowLabel: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700',
  },
  rowDate: {
    color: COLORS.subtext,
    fontSize: 12,
    marginTop: 2,
  },
  rowValue: {
    color: COLORS.accent,
    fontSize: 16,
    fontWeight: '900',
  },
  timelineRow: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.accent,
    marginTop: 5,
  },
  timelineTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '700',
  },
  timelineSub: {
    color: COLORS.subtext,
    fontSize: 12,
    marginTop: 2,
  },
});
