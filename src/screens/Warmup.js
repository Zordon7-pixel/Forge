import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const STEPS = [
  { name: 'Leg Swings', cue: 'Front to back, then side to side. Stay controlled.' },
  { name: 'Hip Circles', cue: 'Hands on hips. Open and close the hips both directions.' },
  { name: 'High Knees', cue: 'Drive knees up and keep a quick, light cadence.' },
  { name: 'Arm Circles', cue: 'Small to large circles forward and backward.' },
  { name: 'Dynamic Lunges', cue: 'Step into each lunge and keep torso tall.' },
  { name: 'Ankle Rolls', cue: 'Roll each ankle both directions before your first stride.' },
];

const STEP_SECONDS = 30;

export default function Warmup() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(STEP_SECONDS);

  const totalSteps = STEPS.length;
  const current = STEPS[index];
  const progressPct = useMemo(() => Math.round(((index + 1) / totalSteps) * 100), [index, totalSteps]);

  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev > 1) return prev - 1;
        return STEP_SECONDS;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const goNext = () => {
    if (index >= totalSteps - 1) {
      navigation.navigate('Run');
      return;
    }
    setIndex((prev) => prev + 1);
    setSecondsLeft(STEP_SECONDS);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + 24 }]}>
      <Text style={styles.kicker}>Dynamic Warmup</Text>
      <Text style={styles.title}>Step {index + 1} of {totalSteps}</Text>

      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
      </View>

      <View style={styles.card}>
        <Text style={styles.exercise}>{current.name}</Text>
        <Text style={styles.cue}>{current.cue}</Text>
        <Text style={styles.timer}>{secondsLeft}s</Text>
      </View>

      <Pressable style={styles.nextButton} onPress={goNext}>
        <Text style={styles.nextButtonText}>{index === totalSteps - 1 ? 'Start Run' : 'Next'}</Text>
      </Pressable>

      <Pressable onPress={() => navigation.navigate('Run')}>
        <Text style={styles.skipText}>Skip warmup</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f1117',
    paddingHorizontal: 20,
  },
  kicker: {
    color: '#EAB308',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 14,
  },
  progressTrack: {
    height: 8,
    borderRadius: 99,
    backgroundColor: '#2c3345',
    overflow: 'hidden',
    marginBottom: 20,
  },
  progressFill: {
    height: 8,
    backgroundColor: '#EAB308',
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2c3345',
    backgroundColor: '#171c27',
    padding: 20,
    marginBottom: 18,
  },
  exercise: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 8,
  },
  cue: {
    color: '#94a3b8',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 22,
  },
  timer: {
    color: '#EAB308',
    fontSize: 42,
    fontWeight: '900',
  },
  nextButton: {
    backgroundColor: '#EAB308',
    borderRadius: 14,
    alignItems: 'center',
    paddingVertical: 14,
    marginBottom: 12,
  },
  nextButtonText: {
    color: '#0f1117',
    fontSize: 16,
    fontWeight: '800',
  },
  skipText: {
    color: '#94a3b8',
    fontSize: 14,
    textAlign: 'center',
  },
});
