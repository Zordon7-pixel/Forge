import React, { useCallback, useMemo, useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Activity, ArrowRight, Dumbbell, Route, ShieldAlert } from 'lucide-react-native';

import api from '../lib/api';
import useHealthData from '../hooks/useHealthData';

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

export default function Dashboard({ navigation }) {
  const [runs, setRuns] = useState([]);
  const [workouts, setWorkouts] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const {
    workouts: healthWorkouts,
    steps,
    heartRate,
    loading: healthLoading,
    error: healthError,
    lastSynced,
    refresh: refreshHealth
  } = useHealthData();

  const loadDashboard = useCallback(async () => {
    setRefreshing(true);
    try {
      const [runsRes, liftsRes] = await Promise.all([
        api.get('/runs?limit=5'),
        api.get('/workouts?limit=5')
      ]);

      const runsData = runsRes?.data?.runs || runsRes?.data || [];
      const workoutsData = liftsRes?.data?.workouts || liftsRes?.data || [];
      setRuns(Array.isArray(runsData) ? runsData : []);
      setWorkouts(Array.isArray(workoutsData) ? workoutsData : []);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadDashboard();
      refreshHealth();
    }, [loadDashboard, refreshHealth])
  );

  const weekStats = useMemo(() => {
    const miles = runs.reduce((acc, run) => acc + Number(run.distance || 0), 0);
    const liftSessions = workouts.length;
    return {
      miles: miles.toFixed(1),
      runs: runs.length,
      lifts: liftSessions
    };
  }, [runs, workouts]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadDashboard(), refreshHealth()]);
  }, [loadDashboard, refreshHealth]);

  const isPermissionError = /denied|permission|authorize/i.test(String(healthError?.message || healthError || ''));
  const lastHealthWorkout = healthWorkouts[0];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl tintColor={COLORS.accent} refreshing={refreshing || healthLoading} onRefresh={refreshAll} />
      }
    >
      <Text style={styles.title}>Dashboard</Text>
      <Text style={styles.subtitle}>Performance snapshot</Text>

      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{weekStats.miles}</Text>
          <Text style={styles.statLabel}>Miles</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{weekStats.runs}</Text>
          <Text style={styles.statLabel}>Runs</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{weekStats.lifts}</Text>
          <Text style={styles.statLabel}>Lifts</Text>
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>Health</Text>
          <View style={styles.inlineRow}>
            <Activity size={14} color={COLORS.accent} />
            <Text style={styles.metaText}>
              {lastSynced ? `Synced ${new Date(lastSynced).toLocaleTimeString()}` : 'Not synced yet'}
            </Text>
          </View>
        </View>

        <View style={styles.healthMetricsRow}>
          <View style={styles.healthMetric}>
            <Text style={styles.healthValue}>{Number(steps || 0).toLocaleString()}</Text>
            <Text style={styles.metricLabel}>Today Steps</Text>
          </View>
          <View style={styles.healthMetric}>
            <Text style={styles.healthValue}>{heartRate ? Math.round(heartRate) : '--'}</Text>
            <Text style={styles.metricLabel}>Resting HR</Text>
          </View>
          <View style={styles.lastWorkoutBlock}>
            <Text style={styles.metricHeading}>Last workout</Text>
            <Text style={styles.lastWorkoutText}>{lastHealthWorkout?.title || 'No health workout found'}</Text>
          </View>
        </View>

        {!!healthError && (
          <View style={styles.errorCard}>
            <View style={styles.inlineRow}>
              <ShieldAlert size={16} color={COLORS.error} />
              <Text style={styles.errorText}>
                {isPermissionError ? 'Health permission not granted.' : 'Unable to sync health data.'}
              </Text>
            </View>
            {isPermissionError && (
              <Pressable onPress={Linking.openSettings} style={styles.settingsButton}>
                <Text style={styles.settingsButtonText}>Open Settings</Text>
              </Pressable>
            )}
          </View>
        )}
      </View>

      <Pressable onPress={() => navigation.navigate('LogRun')} style={styles.primaryAction}>
        <Route size={18} color={COLORS.background} />
        <Text style={styles.primaryActionText}>Log Run</Text>
      </Pressable>

      <Pressable onPress={() => navigation.navigate('LogLift')} style={styles.secondaryAction}>
        <Dumbbell size={18} color={COLORS.accent} />
        <Text style={styles.secondaryActionText}>Log Lift</Text>
      </Pressable>

      <Text style={styles.sectionTitle}>Recent Activity</Text>

      <View style={styles.activityList}>
        {runs.map((run, index) => (
          <View key={`run-${run.id || index}`} style={styles.activityCard}>
            <Text style={styles.activityTitle}>Run</Text>
            <Text style={styles.activityMeta}>
              {Number(run.distance || 0).toFixed(2)} mi - {Math.floor(Number(run.duration || 0) / 60)} min
            </Text>
          </View>
        ))}
        {workouts.map((lift, index) => (
          <View key={`lift-${lift.id || index}`} style={styles.activityCard}>
            <Text style={styles.activityTitle}>{lift.name || 'Lift Session'}</Text>
            <Text style={styles.activityMeta}>{(lift.sets || []).length} sets recorded</Text>
          </View>
        ))}
        {!runs.length && !workouts.length && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>No activity logged yet.</Text>
            <ArrowRight size={18} color={COLORS.subtext} style={styles.emptyIcon} />
          </View>
        )}
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
  title: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: '700'
  },
  subtitle: {
    color: COLORS.subtext,
    fontSize: 15,
    marginTop: 4,
    marginBottom: 18
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 14
  },
  statCard: {
    flex: 1,
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 10,
    marginHorizontal: 4
  },
  statValue: {
    color: COLORS.accent,
    fontSize: 26,
    fontWeight: '700'
  },
  statLabel: {
    color: COLORS.subtext,
    fontSize: 12,
    marginTop: 2
  },
  card: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginTop: 4
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  cardTitle: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: '600'
  },
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  metaText: {
    color: COLORS.subtext,
    fontSize: 12,
    marginLeft: 6
  },
  healthMetricsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 14
  },
  healthMetric: {
    width: '27%'
  },
  healthValue: {
    color: COLORS.accent,
    fontSize: 20,
    fontWeight: '700'
  },
  metricLabel: {
    color: COLORS.subtext,
    fontSize: 12,
    marginTop: 2
  },
  lastWorkoutBlock: {
    width: '42%'
  },
  metricHeading: {
    color: COLORS.subtext,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4
  },
  lastWorkoutText: {
    color: COLORS.text,
    fontSize: 13,
    marginTop: 4,
    lineHeight: 18
  },
  errorCard: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginTop: 14
  },
  errorText: {
    color: COLORS.subtext,
    fontSize: 13,
    marginLeft: 8,
    flexShrink: 1
  },
  settingsButton: {
    marginTop: 10,
    alignSelf: 'flex-start',
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  settingsButtonText: {
    color: COLORS.background,
    fontWeight: '700',
    fontSize: 12
  },
  primaryAction: {
    marginTop: 14,
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 14,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row'
  },
  primaryActionText: {
    color: COLORS.background,
    fontSize: 16,
    fontWeight: '700',
    marginLeft: 8
  },
  secondaryAction: {
    marginTop: 10,
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row'
  },
  secondaryActionText: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8
  },
  sectionTitle: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '700',
    marginTop: 24,
    marginBottom: 10
  },
  activityList: {
    marginBottom: 12
  },
  activityCard: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10
  },
  activityTitle: {
    color: COLORS.text,
    fontWeight: '600',
    fontSize: 15
  },
  activityMeta: {
    color: COLORS.subtext,
    marginTop: 4,
    fontSize: 13
  },
  emptyCard: {
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 12,
    padding: 18
  },
  emptyText: {
    color: COLORS.subtext,
    fontSize: 14
  },
  emptyIcon: {
    marginTop: 8
  }
});
