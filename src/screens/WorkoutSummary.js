import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import api from '../lib/api';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
  success: '#22c55e'
};

export default function WorkoutSummary({ navigation, route }) {
  const workoutName = route?.params?.workoutName || 'Strength Session';
  const exercises = Array.isArray(route?.params?.exercises) ? route.params.exercises : [];
  const logs = Array.isArray(route?.params?.logs) ? route.params.logs : [];

  const [saving, setSaving] = useState(false);

  const summary = useMemo(() => {
    const totalVolume = logs.reduce((sum, row) => sum + Number(row.weight_lbs || 0) * Number(row.reps || 0), 0);
    const exerciseMap = new Map();

    logs.forEach((row) => {
      const key = row.exercise_name || `Exercise ${row.exerciseIndex + 1}`;
      if (!exerciseMap.has(key)) {
        exerciseMap.set(key, {
          name: key,
          sets: 0,
          reps: 0,
          maxWeight: 0,
          volume: 0
        });
      }
      const item = exerciseMap.get(key);
      item.sets += 1;
      item.reps += Number(row.reps || 0);
      item.maxWeight = Math.max(item.maxWeight, Number(row.weight_lbs || 0));
      item.volume += Number(row.weight_lbs || 0) * Number(row.reps || 0);
    });

    const perExercise = Array.from(exerciseMap.values());

    const prHits = perExercise.filter((item) => item.maxWeight >= 0.95 * (item.maxWeight || 1) && item.maxWeight > 0).length;

    return {
      totalVolume,
      exercisesCompleted: perExercise.length,
      prHits,
      perExercise
    };
  }, [logs]);

  const submit = async () => {
    try {
      setSaving(true);
      await api.post('/workouts/strength', {
        name: workoutName,
        exercises,
        sets: logs,
        total_volume: summary.totalVolume,
        exercises_completed: summary.exercisesCompleted,
        personal_records_hit: summary.prHits,
        completed_at: new Date().toISOString()
      });

      Alert.alert('Workout Saved', 'Strength workout was saved.');
      navigation.navigate('Main', { screen: 'Plan' });
    } catch (error) {
      Alert.alert('Save Failed', error?.response?.data?.error || 'Could not save workout summary.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.title}>Workout Summary</Text>
        <Text style={styles.subTitle}>{workoutName}</Text>

        <View style={styles.metricsRow}>
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>Total Volume</Text>
            <Text style={styles.metricValue}>{Math.round(summary.totalVolume)} lb</Text>
          </View>
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>Exercises</Text>
            <Text style={styles.metricValue}>{summary.exercisesCompleted}</Text>
          </View>
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>PRs Hit</Text>
            <Text style={[styles.metricValue, { color: COLORS.success }]}>{summary.prHits}</Text>
          </View>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Exercise Breakdown</Text>
        {summary.perExercise.map((item) => (
          <View key={item.name} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.exerciseName}>{item.name}</Text>
              <Text style={styles.exerciseSub}>{item.sets} sets · {item.reps} reps</Text>
            </View>
            <Text style={styles.exerciseVolume}>{Math.round(item.volume)} lb</Text>
          </View>
        ))}
      </View>

      <Pressable onPress={submit} disabled={saving} style={[styles.saveBtn, saving && styles.disabled]}>
        <Text style={styles.saveText}>{saving ? 'Saving...' : 'Save Strength Workout'}</Text>
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
    padding: 16,
    gap: 12,
    paddingBottom: 24
  },
  card: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    backgroundColor: COLORS.card,
    padding: 14,
    gap: 12
  },
  title: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '800'
  },
  subTitle: {
    color: COLORS.subtext,
    fontSize: 14
  },
  metricsRow: {
    flexDirection: 'row',
    gap: 8
  },
  metricBox: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: '#1e2433',
    padding: 10,
    gap: 4
  },
  metricLabel: {
    color: COLORS.subtext,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.8
  },
  metricValue: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '800'
  },
  sectionTitle: {
    color: COLORS.subtext,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    backgroundColor: '#1e2433',
    padding: 10
  },
  exerciseName: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700'
  },
  exerciseSub: {
    color: COLORS.subtext,
    fontSize: 12,
    marginTop: 2
  },
  exerciseVolume: {
    color: COLORS.accent,
    fontWeight: '800'
  },
  saveBtn: {
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    paddingVertical: 13,
    alignItems: 'center'
  },
  saveText: {
    color: '#000',
    fontWeight: '800',
    fontSize: 15
  },
  disabled: {
    opacity: 0.6
  }
});
