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
  input: '#1e2433'
};

const DISTANCES = [
  { key: '5K', miles: 3.1 },
  { key: '10K', miles: 6.2 },
  { key: 'half', miles: 13.1 },
  { key: 'full', miles: 26.2 },
  { key: 'ultra', miles: 31.0 }
];

const toDays = (date) => {
  const target = new Date(`${date}T12:00:00`).getTime();
  if (Number.isNaN(target)) return null;
  return Math.ceil((target - Date.now()) / 86400000);
};

export default function Races() {
  const [races, setRaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generatingId, setGeneratingId] = useState(null);
  const [form, setForm] = useState({
    race_name: '',
    race_date: '',
    distance: '5K',
    goal_time: ''
  });

  const loadRaces = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/races').catch(() => ({ data: { races: [] } }));
      setRaces(response?.data?.races || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadRaces();
    }, [loadRaces])
  );

  const nextRace = useMemo(() => {
    const upcoming = races
      .map((race) => ({ ...race, _days: toDays(race.race_date) }))
      .filter((race) => race._days !== null && race._days >= 0)
      .sort((a, b) => a._days - b._days);
    return upcoming[0] || null;
  }, [races]);

  const upcoming = useMemo(
    () => races.filter((race) => {
      const days = toDays(race.race_date);
      return days !== null && days >= 0;
    }).sort((a, b) => String(a.race_date).localeCompare(String(b.race_date))),
    [races]
  );

  const past = useMemo(
    () => races.filter((race) => {
      const days = toDays(race.race_date);
      return days !== null && days < 0;
    }).sort((a, b) => String(b.race_date).localeCompare(String(a.race_date))),
    [races]
  );

  const submit = async () => {
    if (!form.race_name.trim() || !form.race_date) {
      Alert.alert('Missing Fields', 'Race name and date are required.');
      return;
    }

    const distanceMeta = DISTANCES.find((item) => item.key === form.distance) || DISTANCES[0];

    try {
      await api.post('/races', {
        race_name: form.race_name.trim(),
        race_date: form.race_date,
        distance: form.distance,
        distance_miles: distanceMeta.miles,
        goal_time: form.goal_time,
        goal_time_seconds: form.goal_time
      });
      setForm({ race_name: '', race_date: '', distance: '5K', goal_time: '' });
      await loadRaces();
    } catch (error) {
      Alert.alert('Save Failed', error?.response?.data?.error || 'Could not add race.');
    }
  };

  const generatePlan = async (race) => {
    try {
      setGeneratingId(race.id);
      await api.post('/plans/generate', {
        race_name: race.race_name,
        race_date: race.race_date,
        distance: race.distance,
        goal_time: race.goal_time,
        target: {
          raceDate: race.race_date,
          raceName: race.race_name,
          distanceMiles: Number(race.distance_miles || 0)
        }
      });
      Alert.alert('Plan Updated', `Race plan generated for ${race.race_name}.`);
    } catch (error) {
      Alert.alert('Generate Failed', error?.response?.data?.error || 'Could not generate race plan.');
    } finally {
      setGeneratingId(null);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Races</Text>

      {nextRace && (
        <View style={styles.nextRaceCard}>
          <Text style={styles.section}>Next Race</Text>
          <Text style={styles.nextRaceName}>{nextRace.race_name}</Text>
          <Text style={styles.nextRaceDays}>{Math.max(0, toDays(nextRace.race_date) || 0)} days to go</Text>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.section}>Add Upcoming Race</Text>

        <TextInput
          value={form.race_name}
          onChangeText={(v) => setForm((prev) => ({ ...prev, race_name: v }))}
          style={styles.input}
          placeholder="Race name"
          placeholderTextColor={COLORS.subtext}
        />
        <TextInput
          value={form.race_date}
          onChangeText={(v) => setForm((prev) => ({ ...prev, race_date: v }))}
          style={styles.input}
          placeholder="Race date (YYYY-MM-DD)"
          placeholderTextColor={COLORS.subtext}
        />

        <View style={styles.rowWrap}>
          {DISTANCES.map((item) => (
            <Pressable
              key={item.key}
              onPress={() => setForm((prev) => ({ ...prev, distance: item.key }))}
              style={[styles.pill, form.distance === item.key && styles.pillActive]}
            >
              <Text style={[styles.pillText, form.distance === item.key && styles.pillTextActive]}>{item.key}</Text>
            </Pressable>
          ))}
        </View>

        <TextInput
          value={form.goal_time}
          onChangeText={(v) => setForm((prev) => ({ ...prev, goal_time: v }))}
          style={styles.input}
          placeholder="Goal time (hh:mm:ss)"
          placeholderTextColor={COLORS.subtext}
        />

        <Pressable onPress={submit} style={styles.primaryBtn}>
          <Text style={styles.primaryText}>Save Race</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.section}>Upcoming</Text>
        {!loading && upcoming.map((race) => (
          <View key={race.id || `${race.race_name}-${race.race_date}`} style={styles.raceRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.raceName}>{race.race_name}</Text>
              <Text style={styles.raceMeta}>{race.race_date} · {race.distance || race.distance_miles}</Text>
              <Text style={styles.raceMeta}>{Math.max(0, toDays(race.race_date) || 0)} days to go</Text>
            </View>
            <Pressable onPress={() => generatePlan(race)} style={styles.secondaryBtn}>
              <Text style={styles.secondaryText}>{generatingId === race.id ? '...' : 'Generate Race Plan'}</Text>
            </Pressable>
          </View>
        ))}
        {!loading && upcoming.length === 0 && <Text style={styles.empty}>No upcoming races.</Text>}
      </View>

      <View style={styles.card}>
        <Text style={styles.section}>Past</Text>
        {!loading && past.map((race) => (
          <View key={race.id || `${race.race_name}-${race.race_date}`} style={styles.raceRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.raceName}>{race.race_name}</Text>
              <Text style={styles.raceMeta}>{race.race_date} · {race.distance || race.distance_miles}</Text>
            </View>
          </View>
        ))}
        {!loading && past.length === 0 && <Text style={styles.empty}>No past races.</Text>}
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
    paddingBottom: 24
  },
  title: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: '800'
  },
  nextRaceCard: {
    borderWidth: 1,
    borderColor: 'rgba(234,179,8,0.35)',
    borderRadius: 16,
    backgroundColor: 'rgba(234,179,8,0.1)',
    padding: 14,
    gap: 4
  },
  nextRaceName: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '800'
  },
  nextRaceDays: {
    color: COLORS.accent,
    fontWeight: '700'
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
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    backgroundColor: COLORS.input,
    color: COLORS.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15
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
    fontWeight: '700'
  },
  pillTextActive: {
    color: COLORS.accent
  },
  primaryBtn: {
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    paddingVertical: 12,
    alignItems: 'center'
  },
  primaryText: {
    color: '#000',
    fontWeight: '800'
  },
  raceRow: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    backgroundColor: COLORS.input,
    padding: 10,
    gap: 8
  },
  raceName: {
    color: COLORS.text,
    fontWeight: '700',
    fontSize: 14
  },
  raceMeta: {
    color: COLORS.subtext,
    fontSize: 12,
    marginTop: 2
  },
  secondaryBtn: {
    borderRadius: 10,
    backgroundColor: COLORS.accent,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  secondaryText: {
    color: '#000',
    fontWeight: '800',
    fontSize: 11
  },
  empty: {
    color: COLORS.subtext,
    fontSize: 13
  }
});
