import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Plus, Save, Trash2 } from 'lucide-react-native';

import api from '../lib/api';
import AppHeader from '../components/AppHeader';
import { syncLiftToHealth } from '../lib/health';
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

const createSet = () => ({ reps: '', weight: '' });
const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MUSCLE_FILTERS = ['All', 'Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Core'];
const EXERCISE_LIBRARY = [
  { name: 'Bench Press', group: 'Chest' },
  { name: 'Incline Dumbbell Press', group: 'Chest' },
  { name: 'Barbell Row', group: 'Back' },
  { name: 'Lat Pulldown', group: 'Back' },
  { name: 'Overhead Press', group: 'Shoulders' },
  { name: 'Lateral Raise', group: 'Shoulders' },
  { name: 'Barbell Curl', group: 'Arms' },
  { name: 'Skull Crushers', group: 'Arms' },
  { name: 'Back Squat', group: 'Legs' },
  { name: 'Romanian Deadlift', group: 'Legs' },
  { name: 'Plank', group: 'Core' },
  { name: 'Hanging Leg Raise', group: 'Core' },
];

function buildWeeklyPlan(rec) {
  if (Array.isArray(rec?.weeklyPlan) && rec.weeklyPlan.length >= 6) {
    return rec.weeklyPlan.slice(0, 7).map((workout, index) => ({
      id: String(workout.id || `${index}`),
      day: workout.day || WEEK_DAYS[index] || `Day ${index + 1}`,
      workoutName: workout.workoutName || workout.name || `Workout ${index + 1}`,
      main: Array.isArray(workout.main) ? workout.main : [],
      warmup: workout.warmup || rec?.warmup || '',
      recovery: workout.recovery || rec?.recovery || '',
      target: workout.target || rec?.target || '',
    }));
  }

  const firstExercise = rec?.main?.[0];
  const baseName = rec?.workoutName || 'AI Workout';
  const mainName = typeof firstExercise === 'string'
    ? firstExercise
    : firstExercise?.exercise || firstExercise?.name || 'Compound Lift';
  const templates = [
    { name: `${baseName} A`, target: rec?.target || 'Upper Body', exercise: mainName },
    { name: `${baseName} B`, target: 'Lower Body', exercise: 'Back Squat' },
    { name: `${baseName} C`, target: 'Pull Focus', exercise: 'Barbell Row' },
    { name: `${baseName} D`, target: 'Push Focus', exercise: 'Overhead Press' },
    { name: `${baseName} E`, target: 'Posterior Chain', exercise: 'Romanian Deadlift' },
    { name: `${baseName} F`, target: 'Core + Accessory', exercise: 'Weighted Carry' },
    { name: `${baseName} G`, target: 'Recovery Lift', exercise: 'Single-Leg Work' },
  ];
  return templates.map((template, index) => ({
    id: String(index),
    day: WEEK_DAYS[index],
    workoutName: template.name,
    target: template.target,
    warmup: rec?.warmup || '',
    recovery: rec?.recovery || '',
    main: [{ name: template.exercise, sets: 3, reps: '8-12' }],
  }));
}

export default function LogLift({ navigation }) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [sets, setSets] = useState([createSet()]);
  const [saving, setSaving] = useState(false);
  const [liftMode, setLiftMode] = useState('ai');
  const [lastLift, setLastLift] = useState(null);
  const [aiRec, setAiRec] = useState(null);
  const [weeklyPlan, setWeeklyPlan] = useState([]);
  const [aiLoading, setAiLoading] = useState(true);
  const [muscleFilter, setMuscleFilter] = useState('All');

  useEffect(() => {
    api.get('/lifts').then(res => {
      const lifts = Array.isArray(res.data) ? res.data : res.data?.lifts || [];
      setLastLift(lifts[0] || null);
    }).catch(() => {});
    api.get('/ai/workout-recommendation?date=today').then(res => {
      const recommendation = res.data?.recommendation || null;
      setAiRec(recommendation);
      setWeeklyPlan(buildWeeklyPlan(recommendation));
    }).catch(() => {
      setAiRec(null);
      setWeeklyPlan([]);
    }).finally(() => setAiLoading(false));
  }, []);

  useEffect(() => {
    return () => {
      WorkoutBroadcast.stop();
    };
  }, []);

  useEffect(() => {
    const hasStarted = Boolean(name.trim()) || sets.some((set) => set.reps || set.weight);

    if (!hasStarted) {
      WorkoutBroadcast.stop();
      return;
    }

    WorkoutBroadcast.start({
      workoutType: 'lift',
      getPayload: () => ({
        status: 'running',
        exercise: name || 'Lift Session',
        sets: sets.length,
        completedSets: sets.filter((set) => Number(set.reps) > 0).length,
        elapsed: 0,
        distance: 0,
        pace: '0:00',
        heartRate: null
      })
    });
  }, [name, sets]);

  const updateSet = (index, key, value) => {
    setSets((prev) => prev.map((set, i) => (i === index ? { ...set, [key]: value } : set)));
  };

  const addSet = () => setSets((prev) => [...prev, createSet()]);
  const removeSet = (index) => setSets((prev) => prev.filter((_, i) => i !== index));
  const filteredExercises = useMemo(
    () => EXERCISE_LIBRARY.filter((exercise) => muscleFilter === 'All' || exercise.group === muscleFilter),
    [muscleFilter]
  );
  const startPlannedWorkout = (workout) => {
    const workoutName = workout?.workoutName || workout?.name || aiRec?.workoutName || '';
    setName(workoutName);
    const firstMain = workout?.main?.[0];
    const parsedSets = Number(firstMain?.sets || 0);
    const parsedWeight = Number(firstMain?.weight || firstMain?.weight_lbs || 0);
    const parsedReps = Number(firstMain?.reps || String(firstMain?.reps || '').split('-')[0] || 0);
    if (parsedSets > 0) {
      setSets(Array.from({ length: parsedSets }, () => ({
        reps: parsedReps > 0 ? String(parsedReps) : '',
        weight: parsedWeight > 0 ? String(parsedWeight) : '',
      })));
    } else {
      setSets([createSet()]);
    }
    setLiftMode('Manual');
  };

  const handleSave = async () => {
    const cleanSets = sets
      .map((set) => ({ reps: Number(set.reps), weight: Number(set.weight) }))
      .filter((set) => Number.isFinite(set.reps) && Number.isFinite(set.weight) && set.reps > 0);

    if (!name || !cleanSets.length) {
      Alert.alert('Missing Data', 'Exercise name and at least one valid set are required.');
      return;
    }

    const payload = {
      name,
      sets: cleanSets,
      date: new Date().toISOString()
    };

    try {
      setSaving(true);
      WorkoutBroadcast.stop();
      await api.post('/workouts', payload);
      try {
        await syncLiftToHealth(payload);
      } catch {
        // Health sync failure should not block workout save.
      }
      Alert.alert('Saved', 'Workout logged successfully.');
      navigation.goBack();
    } catch (error) {
      Alert.alert('Save Failed', error?.response?.data?.message || 'Unable to save workout.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView style={[styles.container, { paddingTop: insets.top }]} contentContainerStyle={styles.content}>
      <AppHeader />
      <Text style={styles.title}>Start Workout</Text>
      <Text style={styles.subtitle}>Select the muscle groups you are targeting today</Text>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
        {MUSCLE_FILTERS.map((filter) => {
          const active = filter === muscleFilter;
          return (
            <Pressable
              key={filter}
              onPress={() => setMuscleFilter(filter)}
              style={[styles.filterChip, active && styles.filterChipActive]}
            >
              <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{filter}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.exerciseRow}>
        {filteredExercises.slice(0, 6).map((exercise) => (
          <Pressable
            key={exercise.name}
            onPress={() => {
              setName(exercise.name);
              setLiftMode('Manual');
            }}
            style={styles.exerciseChip}
          >
            <Text style={styles.exerciseChipText}>{exercise.name}</Text>
          </Pressable>
        ))}
      </View>

      {/* Last Logged Lift */}
      {lastLift && (
        <View style={styles.lastLiftCard}>
          <Text style={styles.lastLiftLabel}>Last Logged Lift</Text>
          <Text style={styles.lastLiftName}>{lastLift.exercise_name || 'Lift'}</Text>
          <Text style={styles.lastLiftStats}>
            {lastLift.sets} x {lastLift.reps} @ {lastLift.weight_lbs} lbs
          </Text>
          {lastLift.weight_lbs && (
            <Text style={styles.lastLiftTip}>
              Volume dipped from last session — try adding 5 lbs next time.
            </Text>
          )}
        </View>
      )}

      {/* Manual | AI Recommends tabs */}
      <View style={styles.modeTabs}>
        {['Manual', 'AI Recommends'].map((mode) => {
          const key = mode === 'AI Recommends' ? 'ai' : 'Manual';
          const active = liftMode === key;
          return (
            <Pressable
              key={mode}
              onPress={() => setLiftMode(key)}
              style={[styles.modeTab, active && styles.modeTabActive]}
            >
              <Text style={[styles.modeTabText, active && styles.modeTabTextActive]}>{mode}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* AI Recommendation Card */}
      {liftMode === 'ai' && (
        <View style={styles.aiCard}>
          {aiLoading ? (
            <Text style={styles.aiLoadingText}>Generating your workout...</Text>
          ) : aiRec ? (
            <>
              <View style={styles.aiCardHeader}>
                <Text style={styles.aiCardTitle}>Your Weekly AI Plan</Text>
                <View style={styles.forgeBadge}>
                  <Text style={styles.forgeBadgeText}>FORGE</Text>
                </View>
              </View>
              <Text style={styles.aiNotes}>Pick one of your {weeklyPlan.length || 7} workouts to start.</Text>
              <ScrollView style={styles.planList} nestedScrollEnabled={true} showsVerticalScrollIndicator={false}>
                {weeklyPlan.map((workout) => (
                  <Pressable
                    key={workout.id}
                    onPress={() => startPlannedWorkout(workout)}
                    style={styles.planRow}
                  >
                    <View style={styles.planDayBadge}>
                      <Text style={styles.planDayText}>{workout.day}</Text>
                    </View>
                    <View style={styles.planMeta}>
                      <Text style={styles.planName}>{workout.workoutName}</Text>
                      <Text style={styles.planSub}>
                        {workout.target || 'Strength'} · {(workout.main || []).map((item) => typeof item === 'string' ? item : item.name || item.exercise).filter(Boolean).slice(0, 2).join(', ') || 'Open plan'}
                      </Text>
                    </View>
                    <Text style={styles.planCta}>Start</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </>
          ) : (
            <Text style={styles.aiLoadingText}>No recommendation available. Try Manual mode.</Text>
          )}
        </View>
      )}

      {/* Manual Form */}
      {liftMode === 'Manual' && (
        <>
        <View style={styles.card}>
        <Text style={styles.label}>Exercise Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Bench Press"
          placeholderTextColor={COLORS.subtext}
          style={styles.input}
        />
      </View>

      <View style={styles.listWrap}>
        {sets.map((set, index) => (
          <View key={`set-${index}`} style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={styles.setTitle}>Set {index + 1}</Text>
              {sets.length > 1 && (
                <Pressable onPress={() => removeSet(index)}>
                  <Trash2 color={COLORS.subtext} size={16} />
                </Pressable>
              )}
            </View>

            <View style={styles.inputsRow}>
              <TextInput
                value={set.reps}
                onChangeText={(v) => updateSet(index, 'reps', v)}
                keyboardType="numeric"
                placeholder="Reps"
                placeholderTextColor={COLORS.subtext}
                style={[styles.input, styles.halfInput]}
              />
              <TextInput
                value={set.weight}
                onChangeText={(v) => updateSet(index, 'weight', v)}
                keyboardType="numeric"
                placeholder="Weight"
                placeholderTextColor={COLORS.subtext}
                style={[styles.input, styles.halfInput]}
              />
            </View>
          </View>
        ))}
      </View>

      <Pressable onPress={addSet} style={styles.secondaryButton}>
        <Plus size={18} color={COLORS.accent} />
        <Text style={styles.secondaryButtonText}>Add Set</Text>
      </Pressable>

      <Pressable onPress={handleSave} disabled={saving} style={[styles.primaryButton, saving && styles.disabledButton]}>
        <Save size={18} color={COLORS.background} />
        <Text style={styles.primaryButtonText}>{saving ? 'Saving...' : 'Save Workout'}</Text>
      </Pressable>
        </>
      )}
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
    paddingBottom: 32
  },
  lastLiftCard: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12
  },
  lastLiftLabel: { fontSize: 11, color: COLORS.subtext, marginBottom: 4 },
  lastLiftName: { fontSize: 15, fontWeight: '700', color: COLORS.text },
  lastLiftStats: { fontSize: 13, color: COLORS.subtext, marginTop: 4 },
  lastLiftTip: { fontSize: 12, color: COLORS.subtext, marginTop: 6, lineHeight: 18 },
  modeTabs: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14
  },
  modeTab: {
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 999,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  modeTabActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent
  },
  modeTabText: { fontSize: 13, fontWeight: '700', color: COLORS.subtext },
  modeTabTextActive: { color: '#000' },
  aiCard: {
    borderWidth: 1.5,
    borderColor: COLORS.accent,
    borderStyle: 'dashed',
    borderRadius: 16,
    padding: 18,
    marginBottom: 14,
    backgroundColor: COLORS.card
  },
  aiCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12
  },
  aiCardTitle: { fontSize: 15, fontWeight: '700', color: COLORS.text, flex: 1, marginRight: 8 },
  forgeBadge: {
    backgroundColor: COLORS.accent,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3
  },
  forgeBadgeText: { fontSize: 10, fontWeight: '900', color: '#000' },
  aiSection: { fontSize: 13, color: COLORS.text, marginBottom: 8, lineHeight: 20 },
  aiSectionLabel: { fontWeight: '700', fontStyle: 'italic' },
  aiNotes: { fontSize: 12, color: COLORS.subtext, marginTop: 4, marginBottom: 12, lineHeight: 18 },
  aiLoadingText: { fontSize: 13, color: COLORS.subtext, textAlign: 'center', paddingVertical: 12 },
  planList: { maxHeight: 360, gap: 8 },
  planRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 10
  },
  planDayBadge: {
    backgroundColor: '#2a2f3f',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
    marginRight: 10
  },
  planDayText: { color: COLORS.accent, fontSize: 11, fontWeight: '800' },
  planMeta: { flex: 1 },
  planName: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  planSub: { color: COLORS.subtext, fontSize: 11, marginTop: 2 },
  planCta: { color: COLORS.accent, fontSize: 12, fontWeight: '800' },
  aiStartButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 8
  },
  aiStartButtonText: { fontSize: 15, fontWeight: '700', color: '#000' },
  title: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: '700'
  },
  subtitle: {
    color: COLORS.subtext,
    marginTop: 4,
    fontSize: 15
  },
  filterRow: {
    gap: 8,
    paddingTop: 10,
    paddingBottom: 8,
    paddingRight: 10
  },
  filterChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    paddingHorizontal: 12,
    paddingVertical: 7
  },
  filterChipActive: {
    borderColor: COLORS.accent,
    backgroundColor: '#3a3211'
  },
  filterChipText: {
    color: COLORS.subtext,
    fontSize: 12,
    fontWeight: '700'
  },
  filterChipTextActive: {
    color: COLORS.accent
  },
  exerciseRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12
  },
  exerciseChip: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: '#111827',
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  exerciseChipText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '600'
  },
  card: {
    marginTop: 14,
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14
  },
  label: {
    color: COLORS.subtext,
    fontSize: 13,
    marginBottom: 8
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
    borderRadius: 12,
    color: COLORS.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15
  },
  listWrap: {
    marginTop: 2
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  setTitle: {
    color: COLORS.text,
    fontWeight: '600',
    fontSize: 16
  },
  inputsRow: {
    marginTop: 12,
    flexDirection: 'row',
    justifyContent: 'space-between'
  },
  halfInput: {
    width: '48%'
  },
  secondaryButton: {
    marginTop: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    paddingVertical: 14,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row'
  },
  secondaryButtonText: {
    color: COLORS.text,
    fontWeight: '600',
    marginLeft: 8,
    fontSize: 15
  },
  primaryButton: {
    marginTop: 10,
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    paddingVertical: 14,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row'
  },
  primaryButtonText: {
    color: COLORS.background,
    fontWeight: '700',
    marginLeft: 8,
    fontSize: 15
  },
  disabledButton: {
    opacity: 0.7
  }
});
