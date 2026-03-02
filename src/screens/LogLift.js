import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Plus, Save, Trash2 } from 'lucide-react-native';

import api from '../lib/api';
import { syncLiftToHealth } from '../lib/health';
import WorkoutBroadcast from '../services/WorkoutBroadcast';

const createSet = () => ({ reps: '', weight: '' });

export default function LogLift({ navigation }) {
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
    <ScrollView className="flex-1 bg-forge-bg px-4 pt-6">
      <Text className="text-2xl font-bold text-forge-text">Log Lift</Text>
      <Text className="mt-1 text-forge-subtext">Record exercise sets, reps, and weight.</Text>

      <View className="mt-5 rounded-2xl border border-forge-border bg-forge-card p-4">
        <Text className="text-sm text-forge-subtext">Exercise Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Bench Press"
          placeholderTextColor="#64748b"
          className="mt-2 rounded-xl border border-forge-border bg-forge-bg px-4 py-3 text-forge-text"
        />
      </View>

      <View className="mt-4 gap-3">
        {sets.map((set, index) => (
          <View key={`set-${index}`} className="rounded-2xl border border-forge-border bg-forge-card p-4">
            <View className="flex-row items-center justify-between">
              <Text className="font-medium text-forge-text">Set {index + 1}</Text>
              {sets.length > 1 && (
                <Pressable onPress={() => removeSet(index)}>
                  <Trash2 color="#94a3b8" size={16} />
                </Pressable>
              )}
            </View>

            <View className="mt-3 flex-row gap-3">
              <TextInput
                value={set.reps}
                onChangeText={(v) => updateSet(index, 'reps', v)}
                keyboardType="numeric"
                placeholder="Reps"
                placeholderTextColor="#64748b"
                className="flex-1 rounded-xl border border-forge-border bg-forge-bg px-4 py-3 text-forge-text"
              />
              <TextInput
                value={set.weight}
                onChangeText={(v) => updateSet(index, 'weight', v)}
                keyboardType="numeric"
                placeholder="Weight"
                placeholderTextColor="#64748b"
                className="flex-1 rounded-xl border border-forge-border bg-forge-bg px-4 py-3 text-forge-text"
              />
            </View>
          </View>
        ))}
      </View>

      <Pressable onPress={addSet} className="mt-4 flex-row items-center justify-center gap-2 rounded-xl border border-forge-border bg-forge-card px-4 py-3">
        <Plus size={18} color="#EAB308" />
        <Text className="font-semibold text-forge-text">Add Set</Text>
      </Pressable>

      <Pressable onPress={handleSave} disabled={saving} className="mt-3 mb-8 flex-row items-center justify-center gap-2 rounded-xl bg-forge-accent px-4 py-3">
        <Save size={18} color="#0f1117" />
        <Text className="font-semibold text-black">{saving ? 'Saving...' : 'Save Workout'}</Text>
      </Pressable>
    </ScrollView>
  );
}
