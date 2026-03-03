import React, { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { ActivitySquare, Database } from 'lucide-react-native';

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

export default function History() {
  const [source, setSource] = useState('forge');
  const [tab, setTab] = useState('runs');
  const [runs, setRuns] = useState([]);
  const [workouts, setWorkouts] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const {
    workouts: healthWorkouts,
    loading: healthLoading,
    error: healthError,
    refresh: refreshHealth
  } = useHealthData();

  const loadData = useCallback(async () => {
    setRefreshing(true);
    try {
      const [runsRes, workoutsRes] = await Promise.all([api.get('/runs'), api.get('/workouts')]);
      setRuns(runsRes?.data?.runs || runsRes?.data || []);
      setWorkouts(workoutsRes?.data?.workouts || workoutsRes?.data || []);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
      refreshHealth();
    }, [loadData, refreshHealth])
  );

  const refreshAll = useCallback(async () => {
    await Promise.all([loadData(), refreshHealth()]);
  }, [loadData, refreshHealth]);

  const healthRuns = healthWorkouts.filter((workout) => workout.type === 'run');
  const healthLifts = healthWorkouts.filter((workout) => workout.type === 'strength');

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl tintColor={COLORS.accent} refreshing={refreshing || healthLoading} onRefresh={refreshAll} />
      }
    >
      <Text style={styles.title}>History</Text>
      <Text style={styles.subtitle}>Review logged training sessions.</Text>

      <View style={styles.segmentedContainer}>
        <Pressable
          onPress={() => setSource('forge')}
          style={[styles.segmentButton, source === 'forge' && styles.segmentButtonActive]}
        >
          <Database size={14} color={source === 'forge' ? COLORS.background : COLORS.subtext} />
          <Text style={[styles.segmentLabel, source === 'forge' && styles.segmentLabelActive]}>FORGE</Text>
        </Pressable>
        <Pressable
          onPress={() => setSource('health')}
          style={[styles.segmentButton, source === 'health' && styles.segmentButtonActive]}
        >
          <ActivitySquare size={14} color={source === 'health' ? COLORS.background : COLORS.subtext} />
          <Text style={[styles.segmentLabel, source === 'health' && styles.segmentLabelActive]}>Health</Text>
        </Pressable>
      </View>

      <View style={styles.segmentedContainer}>
        <Pressable onPress={() => setTab('runs')} style={[styles.segmentButton, tab === 'runs' && styles.segmentButtonActive]}>
          <Text style={[styles.segmentLabel, tab === 'runs' && styles.segmentLabelActive]}>Runs</Text>
        </Pressable>
        <Pressable onPress={() => setTab('lifts')} style={[styles.segmentButton, tab === 'lifts' && styles.segmentButtonActive]}>
          <Text style={[styles.segmentLabel, tab === 'lifts' && styles.segmentLabelActive]}>Lifts</Text>
        </Pressable>
      </View>

      <View style={styles.listWrap}>
        {source === 'forge' && tab === 'runs' && runs.map((run, index) => (
          <View key={`run-${run.id || index}`} style={styles.activityCard}>
            <Text style={styles.activityTitle}>{Number(run.distance || 0).toFixed(2)} miles</Text>
            <Text style={styles.activityMeta}>
              {Math.floor(Number(run.duration || 0) / 60)} min - {run.pace || 'N/A'} pace
            </Text>
          </View>
        ))}
        {source === 'forge' && tab === 'lifts' && workouts.map((workout, index) => (
          <View key={`workout-${workout.id || index}`} style={styles.activityCard}>
            <Text style={styles.activityTitle}>{workout.name || 'Lift Session'}</Text>
            <Text style={styles.activityMeta}>{(workout.sets || []).length} sets</Text>
          </View>
        ))}

        {source === 'health' && tab === 'runs' && healthRuns.map((workout, index) => (
          <View key={`health-run-${workout.id || index}`} style={styles.activityCard}>
            <Text style={styles.activityTitle}>{workout.title || 'Run'}</Text>
            <Text style={styles.activityMeta}>
              {Math.floor(Number(workout.duration || 0) / 60)} min
              {workout.distanceMiles ? ` - ${Number(workout.distanceMiles).toFixed(2)} mi` : ''}
            </Text>
          </View>
        ))}
        {source === 'health' && tab === 'lifts' && healthLifts.map((workout, index) => (
          <View key={`health-lift-${workout.id || index}`} style={styles.activityCard}>
            <Text style={styles.activityTitle}>{workout.title || 'Strength Training'}</Text>
            <Text style={styles.activityMeta}>{Math.floor(Number(workout.duration || 0) / 60)} min</Text>
          </View>
        ))}

        {source === 'forge' && tab === 'runs' && !runs.length && <Text style={styles.emptyText}>No runs found.</Text>}
        {source === 'forge' && tab === 'lifts' && !workouts.length && <Text style={styles.emptyText}>No workouts found.</Text>}
        {source === 'health' && tab === 'runs' && !healthRuns.length && <Text style={styles.emptyText}>No health runs found.</Text>}
        {source === 'health' && tab === 'lifts' && !healthLifts.length && <Text style={styles.emptyText}>No health strength sessions found.</Text>}
        {source === 'health' && !!healthError && <Text style={styles.errorText}>Health data unavailable. Check permissions in Settings.</Text>}
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
    marginTop: 4
  },
  segmentedContainer: {
    marginTop: 18,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    padding: 4,
    flexDirection: 'row'
  },
  segmentButton: {
    flex: 1,
    borderRadius: 9,
    paddingVertical: 10,
    paddingHorizontal: 12,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row'
  },
  segmentButtonActive: {
    backgroundColor: COLORS.accent
  },
  segmentLabel: {
    color: COLORS.subtext,
    fontWeight: '600',
    marginLeft: 6
  },
  segmentLabelActive: {
    color: COLORS.background
  },
  listWrap: {
    marginTop: 16
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
  emptyText: {
    color: COLORS.subtext,
    textAlign: 'center',
    marginTop: 8
  },
  errorText: {
    color: COLORS.error,
    textAlign: 'center',
    marginTop: 8
  }
});
