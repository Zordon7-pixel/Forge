import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, Vibration, View } from 'react-native';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
  input: '#1e2433',
  success: '#22c55e',
  error: '#ef4444'
};

const REST_PRESETS = [60, 90, 120];

const fmtSeconds = (seconds) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export default function ActiveWorkout({ navigation, route }) {
  const workoutName = route?.params?.workoutName || 'Strength Session';
  const exercises = Array.isArray(route?.params?.exercises) ? route.params.exercises : [];

  const [exerciseIndex, setExerciseIndex] = useState(0);
  const [setCounter, setSetCounter] = useState(1);
  const [weight, setWeight] = useState('');
  const [reps, setReps] = useState('');
  const [logs, setLogs] = useState([]);

  const [restPreset, setRestPreset] = useState(90);
  const [restSeconds, setRestSeconds] = useState(0);
  const [restRunning, setRestRunning] = useState(false);

  const timerRef = useRef(null);

  const currentExercise = exercises[exerciseIndex] || null;
  const targetSets = Number(currentExercise?.sets || 3);
  const targetReps = Number(currentExercise?.reps || 10);

  const currentExerciseLogs = useMemo(
    () => logs.filter((entry) => entry.exerciseIndex === exerciseIndex),
    [logs, exerciseIndex]
  );

  useEffect(() => {
    if (!currentExercise) {
      Alert.alert('Missing Workout', 'No exercises were passed to this session.');
      navigation.goBack();
    }
  }, [currentExercise, navigation]);

  useEffect(() => {
    if (restRunning && restSeconds > 0) {
      timerRef.current = setTimeout(() => setRestSeconds((prev) => prev - 1), 1000);
    } else if (restRunning && restSeconds === 0) {
      setRestRunning(false);
      Vibration.vibrate([0, 250, 120, 250]);
      Alert.alert('Rest Finished', 'Start your next set.');
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [restRunning, restSeconds]);

  const startRest = (seconds) => {
    setRestPreset(seconds);
    setRestSeconds(seconds);
    setRestRunning(true);
  };

  const logSet = () => {
    const weightVal = Number(weight);
    const repsVal = Number(reps);

    if (!weightVal || weightVal <= 0 || !repsVal || repsVal <= 0) {
      Alert.alert('Set Data Missing', 'Enter both weight and reps before logging.');
      return;
    }

    const setEntry = {
      id: `${Date.now()}-${Math.random()}`,
      exerciseIndex,
      exercise_name: currentExercise?.name || `Exercise ${exerciseIndex + 1}`,
      set_number: setCounter,
      weight_lbs: weightVal,
      reps: repsVal,
      target_reps: targetReps
    };

    setLogs((prev) => [...prev, setEntry]);
    setWeight('');
    setReps('');

    if (setCounter < targetSets) {
      setSetCounter((prev) => prev + 1);
      startRest(restPreset);
    }
  };

  const onNextExercise = () => {
    if (currentExerciseLogs.length < targetSets) {
      Alert.alert('Sets Remaining', `Complete ${targetSets} sets before moving on.`);
      return;
    }

    if (exerciseIndex >= exercises.length - 1) {
      navigation.replace('WorkoutSummary', {
        workoutName,
        exercises,
        logs
      });
      return;
    }

    setExerciseIndex((prev) => prev + 1);
    setSetCounter(1);
    setWeight('');
    setReps('');
    setRestRunning(false);
    setRestSeconds(0);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.headerCard}>
        <Text style={styles.workoutName}>{workoutName}</Text>
        <Text style={styles.progressText}>Exercise {exerciseIndex + 1} of {exercises.length}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.exerciseName}>{currentExercise?.name || 'Exercise'}</Text>
        <Text style={styles.meta}>Target: {targetSets} x {targetReps}</Text>
        <Text style={styles.meta}>Current Set: {setCounter}</Text>

        <View style={styles.inputRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Weight (lbs)</Text>
            <TextInput
              value={weight}
              onChangeText={(v) => setWeight(v.replace(/[^0-9.]/g, ''))}
              style={styles.input}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={COLORS.subtext}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Reps</Text>
            <TextInput
              value={reps}
              onChangeText={(v) => setReps(v.replace(/[^0-9]/g, ''))}
              style={styles.input}
              keyboardType="number-pad"
              placeholder="0"
              placeholderTextColor={COLORS.subtext}
            />
          </View>
        </View>

        <Pressable onPress={logSet} style={styles.primaryBtn}>
          <Text style={styles.primaryText}>Log Set</Text>
        </Pressable>

        <View style={styles.restWrap}>
          <Text style={styles.label}>Rest Timer</Text>
          <View style={styles.restRow}>
            {REST_PRESETS.map((seconds) => (
              <Pressable
                key={seconds}
                onPress={() => startRest(seconds)}
                style={[styles.restBtn, restPreset === seconds && styles.restBtnActive]}
              >
                <Text style={[styles.restBtnText, restPreset === seconds && styles.restBtnTextActive]}>{seconds}s</Text>
              </Pressable>
            ))}
          </View>

          <Text style={[styles.restCountdown, restSeconds <= 5 && restSeconds > 0 && { color: COLORS.error }]}>
            {restSeconds > 0 ? fmtSeconds(restSeconds) : 'Ready'}
          </Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Logged Sets</Text>
        {currentExerciseLogs.map((item) => (
          <Text key={item.id} style={styles.logLine}>Set {item.set_number}: {item.reps} reps @ {item.weight_lbs} lbs</Text>
        ))}
        {currentExerciseLogs.length === 0 && <Text style={styles.empty}>No sets logged yet.</Text>}
      </View>

      <Pressable
        onPress={onNextExercise}
        style={[styles.primaryBtn, { marginTop: 4, backgroundColor: COLORS.success }]}
      >
        <Text style={styles.primaryText}>{exerciseIndex >= exercises.length - 1 ? 'Finish Workout' : 'Next Exercise'}</Text>
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
  headerCard: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    padding: 14
  },
  workoutName: {
    color: COLORS.text,
    fontSize: 24,
    fontWeight: '800'
  },
  progressText: {
    color: COLORS.subtext,
    marginTop: 4
  },
  card: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    padding: 14,
    gap: 10
  },
  exerciseName: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: '700'
  },
  meta: {
    color: COLORS.subtext,
    fontSize: 13
  },
  label: {
    color: COLORS.subtext,
    fontSize: 12,
    fontWeight: '700'
  },
  inputRow: {
    flexDirection: 'row',
    gap: 10
  },
  input: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    backgroundColor: COLORS.input,
    color: COLORS.text,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  primaryBtn: {
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    paddingVertical: 12
  },
  primaryText: {
    color: '#000',
    fontSize: 15,
    fontWeight: '800'
  },
  restWrap: {
    marginTop: 4,
    gap: 8
  },
  restRow: {
    flexDirection: 'row',
    gap: 8
  },
  restBtn: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: COLORS.input
  },
  restBtnActive: {
    borderColor: COLORS.accent,
    backgroundColor: '#2f2a10'
  },
  restBtnText: {
    color: COLORS.subtext,
    fontWeight: '700',
    fontSize: 12
  },
  restBtnTextActive: {
    color: COLORS.accent
  },
  restCountdown: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '800',
    textAlign: 'center'
  },
  sectionTitle: {
    color: COLORS.subtext,
    fontSize: 12,
    textTransform: 'uppercase',
    fontWeight: '700',
    letterSpacing: 0.8
  },
  logLine: {
    color: COLORS.text,
    fontSize: 13
  },
  empty: {
    color: COLORS.subtext,
    fontSize: 13
  }
});
