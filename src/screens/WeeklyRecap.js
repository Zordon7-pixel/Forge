import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { AlertTriangle, Brain, Gauge, Ruler, Timer } from 'lucide-react-native';

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

function StatCard({ icon: Icon, label, value, sub }) {
  return (
    <View style={styles.statCard}>
      <View style={styles.statHead}>
        <Icon color={COLORS.accent} size={14} />
        <Text style={styles.statLabel}>{label}</Text>
      </View>
      <Text style={styles.statValue}>{value}</Text>
      {!!sub && <Text style={styles.statSub}>{sub}</Text>}
    </View>
  );
}

export default function WeeklyRecap() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const [recap, setRecap] = useState(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const response = await api.get('/recap/weekly');
      setRecap(response?.data || null);
    } catch (loadError) {
      setRecap(null);
      setError(loadError?.response?.data?.message || 'Unable to load weekly recap.');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setRetrying(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const retry = () => {
    setRetrying(true);
    load(true);
  };

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl tintColor={COLORS.accent} refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} />}
    >
      <AppHeader />

      <View style={styles.heroCard}>
        <Text style={styles.title}>Weekly Recap</Text>
        <Text style={styles.subtitle}>{recap?.weekLabel || 'Your latest training summary'}</Text>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={COLORS.accent} />
          <Text style={styles.loadingText}>Loading recap...</Text>
        </View>
      ) : null}

      {!loading && !!error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>Recap unavailable</Text>
          <Text style={styles.errorBody}>{error}</Text>
          <Pressable style={styles.retryButton} onPress={retry} disabled={retrying}>
            <Text style={styles.retryText}>{retrying ? 'Retrying...' : 'Retry'}</Text>
          </Pressable>
        </View>
      ) : null}

      {!loading && !error && recap ? (
        <>
          <View style={styles.grid}>
            <StatCard icon={Ruler} label="Total Miles" value={Number(recap.totalMiles || 0).toFixed(1)} sub="mi" />
            <StatCard icon={Gauge} label="Runs" value={String(recap.totalRuns || 0)} />
            <StatCard icon={Timer} label="Avg Pace" value={recap.avgPace ? `${recap.avgPace}/mi` : '--'} />
            <StatCard icon={Ruler} label="Next Week" value={recap.nextWeekPreview?.focus || recap.nextWeekPreview || 'Build'} />
          </View>

          <View style={styles.card}>
            <View style={styles.cardHead}>
              <Brain color={COLORS.accent} size={14} />
              <Text style={styles.cardTitle}>AI Narrative</Text>
            </View>
            <Text style={styles.cardBody}>{recap.insight || recap.narrative || 'No narrative available.'}</Text>
          </View>

          {Array.isArray(recap.riskFlags) && recap.riskFlags.length > 0 ? (
            <View style={styles.riskCard}>
              <View style={styles.cardHead}>
                <AlertTriangle color="#fb923c" size={14} />
                <Text style={styles.riskTitle}>Risk Flags</Text>
              </View>
              {recap.riskFlags.map((flag, idx) => (
                <Text key={`risk-${idx}`} style={styles.riskText}>• {flag}</Text>
              ))}
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Next Week Preview</Text>
            <Text style={styles.cardBody}>{recap.nextWeekPreview?.summary || recap.nextWeekPreview || 'No preview available.'}</Text>
          </View>
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
    gap: 10,
  },
  errorTitle: {
    color: '#fca5a5',
    fontWeight: '800',
    fontSize: 15,
  },
  errorBody: {
    color: '#fecaca',
    fontSize: 13,
  },
  retryButton: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: 10,
    alignItems: 'center',
  },
  retryText: {
    color: COLORS.subtext,
    fontSize: 13,
    fontWeight: '700',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 10,
  },
  statCard: {
    width: '48%',
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 12,
  },
  statHead: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
  },
  statLabel: {
    color: COLORS.subtext,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    fontSize: 10,
    fontWeight: '700',
  },
  statValue: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '900',
    marginTop: 8,
  },
  statSub: {
    color: COLORS.subtext,
    fontSize: 12,
    marginTop: 2,
  },
  card: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 14,
    marginTop: 10,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  cardTitle: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  cardBody: {
    color: COLORS.subtext,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 10,
  },
  riskCard: {
    backgroundColor: 'rgba(251,146,60,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(251,146,60,0.4)',
    borderRadius: 14,
    padding: 14,
    marginTop: 10,
    gap: 6,
  },
  riskTitle: {
    color: '#fdba74',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  riskText: {
    color: COLORS.text,
    fontSize: 13,
  },
});
