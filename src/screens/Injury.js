import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api from '../lib/api';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
  input: '#1e2433',
  success: '#22c55e'
};

const BODY_PARTS = ['knee', 'hip', 'hamstring', 'calf', 'foot', 'shin', 'back', 'shoulder', 'ankle'];
const SEVERITY = ['mild', 'moderate', 'severe'];

const PT_LIBRARY = {
  knee: ['Terminal Knee Extensions', 'Spanish Squat Hold', 'Single-Leg Step Down'],
  hip: ['Clamshells', 'Lateral Band Walk', 'Hip Airplanes'],
  hamstring: ['Nordic Eccentric', 'Bridge Walkout', 'Single-Leg RDL'],
  calf: ['Eccentric Calf Raises', 'Bent-Knee Calf Raise', 'Soleus Isometric Hold'],
  foot: ['Toe Yoga', 'Short Foot Drill', 'Single-Leg Balance'],
  shin: ['Tibialis Raises', 'Ankle Dorsiflexion Band', 'Calf Foam Roll'],
  back: ['Bird Dog', 'Dead Bug', 'McGill Curl-Up'],
  shoulder: ['Band External Rotation', 'Scap Wall Slides', 'Face Pull'],
  ankle: ['Ankle ABCs', 'Banded Eversion', 'Single-Leg Balance Reach']
};

const formatDate = (input) => {
  if (!input) return '--';
  const date = new Date(`${input}T12:00:00`);
  if (Number.isNaN(date.getTime())) return input;
  return date.toLocaleDateString();
};

const daysSince = (input) => {
  if (!input) return 0;
  const start = new Date(`${input}T00:00:00`);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  if (Number.isNaN(start.getTime())) return 0;
  return Math.max(0, Math.floor((now.getTime() - start.getTime()) / 86400000));
};

export default function Injury() {
  const today = new Date().toISOString().slice(0, 10);

  const [form, setForm] = useState({
    body_part: 'knee',
    severity: 'mild',
    start_date: today,
    notes: ''
  });

  const [activeInjuries, setActiveInjuries] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  const loadData = useCallback(async () => {
    const response = await api.get('/injury/active').catch(() => ({ data: { injuries: [] } }));
    const injuries = response?.data?.injuries || response?.data || [];
    setActiveInjuries(Array.isArray(injuries) ? injuries : []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  const ptSuggestions = useMemo(() => PT_LIBRARY[form.body_part] || [], [form.body_part]);

  const submit = async () => {
    try {
      setSubmitting(true);
      await api.post('/injury', {
        body_part: form.body_part,
        severity: form.severity,
        pain_level: form.severity === 'mild' ? 3 : form.severity === 'moderate' ? 6 : 8,
        start_date: form.start_date,
        date: form.start_date,
        notes: form.notes
      });
      setForm((prev) => ({ ...prev, notes: '' }));
      await loadData();
      Alert.alert('Logged', 'Injury was logged.');
    } catch (error) {
      Alert.alert('Log Failed', error?.response?.data?.error || 'Could not log injury.');
    } finally {
      setSubmitting(false);
    }
  };

  const markRecovered = async (injury) => {
    const id = injury?.id;
    if (!id) return;

    try {
      await api.put(`/injury/${id}/clear`).catch(async () => {
        await api.post('/injury/resolve', { id });
      });
      await loadData();
    } catch {
      Alert.alert('Update Failed', 'Could not mark injury as recovered.');
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Injury Tracking</Text>

      <View style={styles.card}>
        <Text style={styles.section}>Log New Injury</Text>

        <Text style={styles.label}>Body Part</Text>
        <View style={styles.rowWrap}>
          {BODY_PARTS.map((part) => (
            <Pressable
              key={part}
              onPress={() => setForm((prev) => ({ ...prev, body_part: part }))}
              style={[styles.pill, form.body_part === part && styles.pillActive]}
            >
              <Text style={[styles.pillText, form.body_part === part && styles.pillTextActive]}>{part}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>Severity</Text>
        <View style={styles.rowWrap}>
          {SEVERITY.map((item) => (
            <Pressable
              key={item}
              onPress={() => setForm((prev) => ({ ...prev, severity: item }))}
              style={[styles.pill, form.severity === item && styles.pillActive]}
            >
              <Text style={[styles.pillText, form.severity === item && styles.pillTextActive]}>{item}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>Start Date</Text>
        <TextInput
          value={form.start_date}
          onChangeText={(v) => setForm((prev) => ({ ...prev, start_date: v }))}
          style={styles.input}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={COLORS.subtext}
        />

        <Text style={styles.label}>Notes</Text>
        <TextInput
          value={form.notes}
          onChangeText={(v) => setForm((prev) => ({ ...prev, notes: v }))}
          style={[styles.input, styles.textArea]}
          placeholder="Pain triggers, movement limits, etc."
          placeholderTextColor={COLORS.subtext}
          multiline
        />

        <Pressable onPress={submit} disabled={submitting} style={[styles.primaryBtn, submitting && styles.disabled]}>
          <Text style={styles.primaryText}>{submitting ? 'Saving...' : 'Save Injury'}</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.section}>PT Suggestions ({form.body_part})</Text>
        {ptSuggestions.map((item) => (
          <Text key={item} style={styles.listItem}>• {item}</Text>
        ))}
      </View>

      <View style={styles.card}>
        <Text style={styles.section}>Active Injuries</Text>
        {activeInjuries.map((injury) => (
          <View key={injury.id || `${injury.body_part}-${injury.date}`} style={styles.injuryRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.injuryTitle}>{injury.body_part || 'Injury'} · {injury.severity || 'unknown'}</Text>
              <Text style={styles.injuryMeta}>Started: {formatDate(injury.start_date || injury.date)}</Text>
              <Text style={styles.injuryMeta}>Milestone: Day {daysSince(injury.start_date || injury.date)}</Text>
            </View>
            <Pressable onPress={() => markRecovered(injury)} style={styles.recoveredBtn}>
              <Text style={styles.recoveredText}>Recovered</Text>
            </Pressable>
          </View>
        ))}
        {activeInjuries.length === 0 && <Text style={styles.empty}>No active injuries.</Text>}
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
    padding: 16,
    gap: 12,
    paddingBottom: 26
  },
  title: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: '800'
  },
  card: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    backgroundColor: COLORS.card,
    padding: 14,
    gap: 10
  },
  section: {
    color: COLORS.subtext,
    fontSize: 12,
    textTransform: 'uppercase',
    fontWeight: '700',
    letterSpacing: 0.8
  },
  label: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '700'
  },
  rowWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  pill: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 999,
    backgroundColor: COLORS.input,
    paddingHorizontal: 11,
    paddingVertical: 7
  },
  pillActive: {
    borderColor: COLORS.accent,
    backgroundColor: '#2f2a10'
  },
  pillText: {
    color: COLORS.subtext,
    textTransform: 'capitalize',
    fontWeight: '700'
  },
  pillTextActive: {
    color: COLORS.accent
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    backgroundColor: COLORS.input,
    color: COLORS.text,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  textArea: {
    minHeight: 86,
    textAlignVertical: 'top'
  },
  primaryBtn: {
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    paddingVertical: 12
  },
  primaryText: {
    color: '#000',
    fontWeight: '800'
  },
  disabled: {
    opacity: 0.6
  },
  listItem: {
    color: COLORS.text,
    fontSize: 13
  },
  injuryRow: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    backgroundColor: COLORS.input,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  injuryTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700',
    textTransform: 'capitalize'
  },
  injuryMeta: {
    color: COLORS.subtext,
    fontSize: 12,
    marginTop: 2
  },
  recoveredBtn: {
    borderRadius: 999,
    backgroundColor: COLORS.success,
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  recoveredText: {
    color: '#052e16',
    fontWeight: '800',
    fontSize: 12
  },
  empty: {
    color: COLORS.subtext,
    fontSize: 13
  }
});
