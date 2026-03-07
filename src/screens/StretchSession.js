import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Check, X } from 'lucide-react-native';

import api from '../lib/api';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
  success: '#22c55e',
};

const DEFAULT_SECONDS = 30;

export default function StretchSession({ navigation, route }) {
  const stretches = useMemo(() => {
    const items = Array.isArray(route?.params?.stretches) ? route.params.stretches : [];
    return items.length ? items : [];
  }, [route?.params?.stretches]);

  const [index, setIndex] = useState(0);
  const [remaining, setRemaining] = useState(DEFAULT_SECONDS);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const timerRef = useRef(null);

  const current = stretches[index] || null;
  const isLast = index >= stretches.length - 1;

  useEffect(() => {
    if (!stretches.length) {
      Alert.alert('Missing Session', 'No stretches were passed to this session.');
      navigation.goBack();
    }
  }, [navigation, stretches.length]);

  useEffect(() => {
    setRemaining(DEFAULT_SECONDS);
  }, [index]);

  useEffect(() => {
    if (done || !current) return;
    timerRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          if (isLast) {
            setDone(true);
            return 0;
          }
          setIndex((value) => value + 1);
          return DEFAULT_SECONDS;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [current, done, isLast]);

  const stopTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const handleNext = () => {
    stopTimer();
    if (isLast) {
      setDone(true);
      return;
    }
    setIndex((value) => value + 1);
  };

  const completeSession = async () => {
    if (submitting) return;
    try {
      setSubmitting(true);
      await api.post('/stretches/session', {
        stretch_ids: stretches.map((item) => item.id).filter(Boolean),
        total_stretches: stretches.length,
        seconds_per_stretch: DEFAULT_SECONDS,
        completed_at: new Date().toISOString(),
      });
      Alert.alert('Session Complete', 'Great mobility work today.');
      navigation.goBack();
    } catch (error) {
      Alert.alert('Save Failed', error?.response?.data?.message || 'Unable to save stretch session.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!current) return null;

  const pct = Math.round(((index + (done ? 1 : 0)) / Math.max(stretches.length, 1)) * 100);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.progressTrack}>
        <View style={[styles.progressBar, { width: `${pct}%` }]} />
      </View>

      <View style={styles.header}>
        <Text style={styles.stepText}>{Math.min(index + 1, stretches.length)} / {stretches.length}</Text>
        <Pressable onPress={() => navigation.goBack()} style={styles.closeButton}>
          <X color={COLORS.subtext} size={14} />
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.name}>{current.name || 'Stretch'}</Text>
        <Text style={styles.category}>{current.category || 'Mobility'}</Text>
        <Text style={styles.cue}>{current.cue || current.description || 'Hold steady and breathe.'}</Text>

        {!done ? (
          <View style={styles.timerWrap}>
            <Text style={styles.timer}>{remaining}</Text>
            <Text style={styles.timerSub}>seconds remaining</Text>
          </View>
        ) : (
          <View style={styles.doneWrap}>
            <Check color={COLORS.success} size={24} />
            <Text style={styles.doneText}>Routine complete</Text>
          </View>
        )}
      </View>

      <View style={styles.actions}>
        <Pressable style={styles.secondaryButton} onPress={() => navigation.goBack()}>
          <Text style={styles.secondaryButtonText}>Exit</Text>
        </Pressable>

        {!done ? (
          <Pressable style={styles.primaryButton} onPress={handleNext}>
            <Text style={styles.primaryButtonText}>{isLast ? 'Finish' : 'Next'}</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.successButton} onPress={completeSession} disabled={submitting}>
            <Text style={styles.successButtonText}>{submitting ? 'Saving...' : 'Done'}</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    padding: 16,
    paddingBottom: 28,
  },
  progressTrack: {
    height: 4,
    backgroundColor: '#1f2937',
    borderRadius: 999,
    overflow: 'hidden',
    marginBottom: 16,
  },
  progressBar: {
    height: 4,
    backgroundColor: COLORS.accent,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  stepText: {
    color: COLORS.subtext,
    fontSize: 12,
    fontWeight: '700',
  },
  closeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    padding: 16,
    minHeight: 300,
  },
  name: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  category: {
    color: COLORS.accent,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
  },
  cue: {
    color: COLORS.subtext,
    marginTop: 14,
    fontSize: 14,
    lineHeight: 22,
  },
  timerWrap: {
    marginTop: 42,
    alignItems: 'center',
  },
  timer: {
    fontSize: 64,
    fontWeight: '900',
    color: COLORS.accent,
  },
  timerSub: {
    color: COLORS.subtext,
    fontSize: 12,
    marginTop: 4,
  },
  doneWrap: {
    marginTop: 42,
    alignItems: 'center',
    gap: 8,
  },
  doneText: {
    color: COLORS.success,
    fontSize: 16,
    fontWeight: '800',
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  primaryButton: {
    flex: 2,
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    paddingVertical: 13,
  },
  primaryButtonText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '800',
  },
  secondaryButton: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    alignItems: 'center',
    paddingVertical: 13,
  },
  secondaryButtonText: {
    color: COLORS.subtext,
    fontSize: 14,
    fontWeight: '700',
  },
  successButton: {
    flex: 2,
    borderRadius: 12,
    backgroundColor: COLORS.success,
    alignItems: 'center',
    paddingVertical: 13,
  },
  successButtonText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '800',
  },
});
