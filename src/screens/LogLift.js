import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Plus, Save, Trash2 } from 'lucide-react-native';

import api from '../lib/api';
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

export default function LogLift({ navigation }) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [sets, setSets] = useState([createSet()]);
  const [saving, setSaving] = useState(false);

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
      <Text style={styles.title}>Log Lift</Text>
      <Text style={styles.subtitle}>Record exercise sets, reps, and weight.</Text>

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
