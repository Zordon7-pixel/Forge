import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useEffect, useState } from 'react';
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

export default function LogLift({ navigation }) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [sets, setSets] = useState([createSet()]);
  const [saving, setSaving] = useState(false);
  const [liftMode, setLiftMode] = useState('ai');
  const [lastLift, setLastLift] = useState(null);
  const [aiRec, setAiRec] = useState(null);
  const [aiLoading, setAiLoading] = useState(true);

  useEffect(() => {
    api.get('/lifts').then(res => {
      const lifts = Array.isArray(res.data) ? res.data : res.data?.lifts || [];
      setLastLift(lifts[0] || null);
    }).catch(() => {});
    api.get('/ai/workout-recommendation?date=today').then(res => {
      setAiRec(res.data?.recommendation || null);
    }).catch(() => {
      setAiRec(null);
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
                <Text style={styles.aiCardTitle}>
                  {aiRec.workoutName || 'AI Recommended Workout'}
                </Text>
                <View style={styles.forgeBadge}>
                  <Text style={styles.forgeBadgeText}>FORGE</Text>
                </View>
              </View>
              {aiRec.warmup ? <Text style={styles.aiSection}><Text style={styles.aiSectionLabel}>Warmup: </Text>{aiRec.warmup}</Text> : null}
              {aiRec.main?.length > 0 && (
                <Text style={styles.aiSection}>
                  <Text style={styles.aiSectionLabel}>Main: </Text>
                  {aiRec.main.map(e => typeof e === 'string' ? e : e.exercise || e.name || '').join(', ')}
                </Text>
              )}
              {aiRec.recovery ? <Text style={styles.aiSection}><Text style={styles.aiSectionLabel}>Recovery: </Text>{aiRec.recovery}</Text> : null}
              {aiRec.notes && <Text style={styles.aiNotes}>{aiRec.notes}</Text>}
              <Pressable style={styles.aiStartButton} onPress={() => {
                if (aiRec.workoutName) setName(aiRec.workoutName);
                setLiftMode('Manual');
              }}>
                <Text style={styles.aiStartButtonText}>Start Workout</Text>
              </Pressable>
            </>
          ) : (
            <Text style={styles.aiLoadingText}>No recommendation available. Try Manual mode.</Text>
          )}
        </View>
      )}

      {/* Manual Form */}
      {liftMode === 'Manual' && (
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
