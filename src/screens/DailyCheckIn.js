import React, { useMemo, useState } from 'react';
import {
  Alert,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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

const FEELING_OPTIONS = [
  { value: 1, emoji: '😵', label: 'Exhausted' },
  { value: 2, emoji: '😓', label: 'Tired' },
  { value: 3, emoji: '😐', label: 'Okay' },
  { value: 4, emoji: '🙂', label: 'Good' },
  { value: 5, emoji: '🔥', label: 'Great' }
];

const TIME_OPTIONS = [30, 45, 60, 90];
const FLAG_OPTIONS = [
  { key: 'work_stress', label: 'Work Stress' },
  { key: 'travel', label: 'Travel' },
  { key: 'sick', label: 'Sick' }
];

const MIN_SLEEP = 4;
const MAX_SLEEP = 10;

function SleepSlider({ value, onChange }) {
  const [trackWidth, setTrackWidth] = useState(1);

  const percent = ((value - MIN_SLEEP) / (MAX_SLEEP - MIN_SLEEP)) * 100;

  const setFromX = (x) => {
    const clampedX = Math.max(0, Math.min(trackWidth, x));
    const ratio = clampedX / trackWidth;
    const next = Math.round((MIN_SLEEP + ratio * (MAX_SLEEP - MIN_SLEEP)) * 2) / 2;
    onChange(next);
  };

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => setFromX(event.nativeEvent.locationX),
    onPanResponderMove: (event) => setFromX(event.nativeEvent.locationX)
  }), [trackWidth]);

  return (
    <View style={styles.sliderWrap}>
      <View
        style={styles.sliderTrack}
        onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width || 1)}
        {...panResponder.panHandlers}
      >
        <View style={[styles.sliderFill, { width: `${percent}%` }]} />
        <View style={[styles.sliderThumb, { left: `${percent}%` }]} />
      </View>
      <View style={styles.sliderLabels}>
        <Text style={styles.sliderText}>4h</Text>
        <Text style={styles.sliderValue}>{value.toFixed(1)}h</Text>
        <Text style={styles.sliderText}>10h</Text>
      </View>
    </View>
  );
}

export default function DailyCheckIn({ navigation }) {
  const insets = useSafeAreaInsets();

  const [feeling, setFeeling] = useState(null);
  const [sleepHours, setSleepHours] = useState(7);
  const [timeAvailable, setTimeAvailable] = useState(null);
  const [flags, setFlags] = useState([]);
  const [saving, setSaving] = useState(false);

  const toggleFlag = (nextFlag) => {
    setFlags((prev) => (
      prev.includes(nextFlag)
        ? prev.filter((item) => item !== nextFlag)
        : [...prev, nextFlag]
    ));
  };

  const submit = async () => {
    if (!feeling) {
      Alert.alert('Missing Feeling', 'Select how you are feeling today.');
      return;
    }
    if (!timeAvailable) {
      Alert.alert('Missing Time', 'Select available workout time.');
      return;
    }

    try {
      setSaving(true);
      await api.post('/checkin/daily', {
        feeling,
        sleep_hours: Number(sleepHours),
        time_available: Number(timeAvailable),
        life_flags: flags
      });
      navigation.navigate('Main', { screen: 'Home' });
    } catch (error) {
      Alert.alert('Submit Failed', error?.response?.data?.error || 'Could not submit daily check-in.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top + 8 }]}
      contentContainerStyle={styles.content}
    >
      <Text style={styles.title}>Morning Check-In</Text>
      <Text style={styles.subtitle}>Tell FORGE how your day looks so your plan can adapt.</Text>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>How are you feeling?</Text>
        <View style={styles.feelingRow}>
          {FEELING_OPTIONS.map((item) => (
            <Pressable
              key={item.value}
              onPress={() => setFeeling(item.value)}
              style={[styles.feelingBtn, feeling === item.value && styles.feelingBtnActive]}
            >
              <Text style={styles.feelingEmoji}>{item.emoji}</Text>
              <Text style={[styles.feelingText, feeling === item.value && styles.feelingTextActive]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Sleep Hours</Text>
        <SleepSlider value={sleepHours} onChange={setSleepHours} />
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Time Available Today</Text>
        <View style={styles.rowWrap}>
          {TIME_OPTIONS.map((minutes) => (
            <Pressable
              key={minutes}
              onPress={() => setTimeAvailable(minutes)}
              style={[styles.pill, timeAvailable === minutes && styles.pillActive]}
            >
              <Text style={[styles.pillText, timeAvailable === minutes && styles.pillTextActive]}>
                {minutes >= 90 ? '90+ min' : `${minutes} min`}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Life Flags</Text>
        <View style={styles.rowWrap}>
          {FLAG_OPTIONS.map((item) => (
            <Pressable
              key={item.key}
              onPress={() => toggleFlag(item.key)}
              style={[styles.pill, flags.includes(item.key) && styles.pillActive]}
            >
              <Text style={[styles.pillText, flags.includes(item.key) && styles.pillTextActive]}>
                {item.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Pressable onPress={submit} disabled={saving} style={[styles.submitBtn, saving && styles.disabled]}>
        <Text style={styles.submitText}>{saving ? 'Submitting...' : 'Submit Check-In'}</Text>
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
    paddingBottom: 28,
    gap: 12
  },
  title: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: '800'
  },
  subtitle: {
    color: COLORS.subtext,
    fontSize: 14
  },
  card: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    padding: 14,
    gap: 10
  },
  sectionTitle: {
    color: COLORS.text,
    fontWeight: '700',
    fontSize: 15
  },
  feelingRow: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between'
  },
  feelingBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
    gap: 4,
    backgroundColor: COLORS.input
  },
  feelingBtnActive: {
    borderColor: COLORS.accent,
    backgroundColor: '#2f2a10'
  },
  feelingEmoji: {
    fontSize: 22
  },
  feelingText: {
    color: COLORS.subtext,
    fontSize: 11,
    fontWeight: '700'
  },
  feelingTextActive: {
    color: COLORS.accent
  },
  sliderWrap: {
    gap: 8
  },
  sliderTrack: {
    height: 10,
    borderRadius: 999,
    backgroundColor: COLORS.input,
    overflow: 'visible',
    justifyContent: 'center'
  },
  sliderFill: {
    position: 'absolute',
    left: 0,
    height: 10,
    borderRadius: 999,
    backgroundColor: COLORS.accent
  },
  sliderThumb: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: COLORS.accent,
    marginLeft: -10
  },
  sliderLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  sliderText: {
    color: COLORS.subtext,
    fontSize: 12
  },
  sliderValue: {
    color: COLORS.text,
    fontSize: 14,
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
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  pillActive: {
    borderColor: COLORS.accent,
    backgroundColor: '#2f2a10'
  },
  pillText: {
    color: COLORS.subtext,
    fontWeight: '700',
    fontSize: 13
  },
  pillTextActive: {
    color: COLORS.accent
  },
  submitBtn: {
    borderRadius: 14,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    paddingVertical: 14,
    marginTop: 4
  },
  submitText: {
    color: '#000',
    fontWeight: '800',
    fontSize: 15
  },
  disabled: {
    opacity: 0.6
  }
});
