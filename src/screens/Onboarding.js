import React, { useContext, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import api from '../lib/api';
import { AuthContext } from '../context/AuthContext';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
  input: '#1e2433'
};

const TOTAL_STEPS = 8;

const goalOptions = [
  { key: 'run', label: 'Run Focused' },
  { key: 'lift', label: 'Lift Focused' },
  { key: 'both', label: 'Hybrid (Run + Lift)' }
];

const coachOptions = [
  { key: 'strict', label: 'Strict' },
  { key: 'balanced', label: 'Balanced' },
  { key: 'supportive', label: 'Supportive' }
];

const lifeSituationOptions = [
  { key: 'works_fulltime', label: '9-5 Job' },
  { key: 'works_shifts', label: 'Shift Work' },
  { key: 'student', label: 'Student' },
  { key: 'works_from_home', label: 'Work From Home' },
  { key: 'self_employed', label: 'Self-Employed' },
  { key: 'free_schedule', label: 'Free Schedule' }
];

const injuryOptions = [
  { key: 'none', label: 'No Current Injury' },
  { key: 'recovering', label: 'Recovering' },
  { key: 'chronic', label: 'Chronic Issue' }
];

export default function Onboarding({ navigation }) {
  const insets = useSafeAreaInsets();
  const { refreshUser } = useContext(AuthContext);

  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    age: '',
    weight_lbs: '',
    primary_goal: 'both',
    coach_personality: 'balanced',
    schedule_days_per_week: 4,
    lifestyle: 'works_fulltime',
    injury_status: 'none',
    injury_detail: ''
  });

  const progress = useMemo(() => `${Math.round((step / TOTAL_STEPS) * 100)}%`, [step]);

  const updateField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const validateStep = () => {
    if (step === 1) {
      const age = Number(form.age);
      if (!age || age < 10 || age > 100) {
        Alert.alert('Invalid Age', 'Enter an age between 10 and 100.');
        return false;
      }
    }

    if (step === 2) {
      const weight = Number(form.weight_lbs);
      if (!weight || weight < 50 || weight > 500) {
        Alert.alert('Invalid Weight', 'Enter a weight between 50 and 500 lbs.');
        return false;
      }
    }

    if (step === 7 && form.injury_status !== 'none' && !form.injury_detail.trim()) {
      Alert.alert('Injury Details', 'Add a short injury note so your plan can adapt safely.');
      return false;
    }

    return true;
  };

  const next = () => {
    if (!validateStep()) return;
    setStep((prev) => Math.min(TOTAL_STEPS, prev + 1));
  };

  const back = () => {
    setStep((prev) => Math.max(1, prev - 1));
  };

  const submit = async () => {
    if (!validateStep()) return;

    try {
      setSaving(true);
      await api.post('/auth/onboarding', {
        age: Number(form.age),
        weight_lbs: Number(form.weight_lbs),
        primary_goal: form.primary_goal,
        coach_personality: form.coach_personality,
        schedule_days_per_week: Number(form.schedule_days_per_week),
        lifestyle: form.lifestyle,
        injury_status: form.injury_status,
        injury_detail: form.injury_status === 'none' ? '' : form.injury_detail
      });
      await refreshUser?.();
      navigation.reset({ index: 0, routes: [{ name: 'Main' }] });
    } catch (error) {
      Alert.alert('Onboarding Failed', error?.response?.data?.error || 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top + 8 }]}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: progress }]} />
      </View>

      <View style={styles.card}>
        <Text style={styles.stepText}>Step {step} of {TOTAL_STEPS}</Text>

        {step === 1 && (
          <View style={styles.stepWrap}>
            <Text style={styles.title}>How old are you?</Text>
            <TextInput
              value={form.age}
              onChangeText={(v) => updateField('age', v.replace(/[^0-9]/g, ''))}
              placeholder="Age"
              placeholderTextColor={COLORS.subtext}
              keyboardType="number-pad"
              style={styles.input}
            />
          </View>
        )}

        {step === 2 && (
          <View style={styles.stepWrap}>
            <Text style={styles.title}>What is your weight?</Text>
            <TextInput
              value={form.weight_lbs}
              onChangeText={(v) => updateField('weight_lbs', v.replace(/[^0-9]/g, ''))}
              placeholder="Weight (lbs)"
              placeholderTextColor={COLORS.subtext}
              keyboardType="number-pad"
              style={styles.input}
            />
          </View>
        )}

        {step === 3 && (
          <View style={styles.stepWrap}>
            <Text style={styles.title}>What is your main goal?</Text>
            <View style={styles.grid}>
              {goalOptions.map((item) => (
                <Pressable
                  key={item.key}
                  onPress={() => updateField('primary_goal', item.key)}
                  style={[styles.optionCard, form.primary_goal === item.key && styles.optionCardActive]}
                >
                  <Text style={[styles.optionText, form.primary_goal === item.key && styles.optionTextActive]}>
                    {item.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {step === 4 && (
          <View style={styles.stepWrap}>
            <Text style={styles.title}>Coach personality</Text>
            <View style={styles.grid}>
              {coachOptions.map((item) => (
                <Pressable
                  key={item.key}
                  onPress={() => updateField('coach_personality', item.key)}
                  style={[styles.optionCard, form.coach_personality === item.key && styles.optionCardActive]}
                >
                  <Text style={[styles.optionText, form.coach_personality === item.key && styles.optionTextActive]}>
                    {item.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {step === 5 && (
          <View style={styles.stepWrap}>
            <Text style={styles.title}>Days per week</Text>
            <Text style={styles.subtitle}>How many days can you train consistently?</Text>
            <View style={styles.rowWrap}>
              {[2, 3, 4, 5, 6, 7].map((days) => (
                <Pressable
                  key={days}
                  onPress={() => updateField('schedule_days_per_week', days)}
                  style={[styles.pill, form.schedule_days_per_week === days && styles.pillActive]}
                >
                  <Text style={[styles.pillText, form.schedule_days_per_week === days && styles.pillTextActive]}>
                    {days} days
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {step === 6 && (
          <View style={styles.stepWrap}>
            <Text style={styles.title}>Life situation</Text>
            <View style={styles.rowWrap}>
              {lifeSituationOptions.map((item) => (
                <Pressable
                  key={item.key}
                  onPress={() => updateField('lifestyle', item.key)}
                  style={[styles.pill, form.lifestyle === item.key && styles.pillActive]}
                >
                  <Text style={[styles.pillText, form.lifestyle === item.key && styles.pillTextActive]}>
                    {item.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {step === 7 && (
          <View style={styles.stepWrap}>
            <Text style={styles.title}>Injury status</Text>
            <View style={styles.grid}>
              {injuryOptions.map((item) => (
                <Pressable
                  key={item.key}
                  onPress={() => updateField('injury_status', item.key)}
                  style={[styles.optionCard, form.injury_status === item.key && styles.optionCardActive]}
                >
                  <Text style={[styles.optionText, form.injury_status === item.key && styles.optionTextActive]}>
                    {item.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {form.injury_status !== 'none' && (
              <TextInput
                value={form.injury_detail}
                onChangeText={(v) => updateField('injury_detail', v)}
                placeholder="Describe your injury"
                placeholderTextColor={COLORS.subtext}
                style={[styles.input, styles.textArea]}
                multiline
              />
            )}
          </View>
        )}

        {step === 8 && (
          <View style={styles.stepWrap}>
            <Text style={styles.title}>Review</Text>
            <Text style={styles.summary}>Age: {form.age}</Text>
            <Text style={styles.summary}>Weight: {form.weight_lbs} lbs</Text>
            <Text style={styles.summary}>Goal: {form.primary_goal}</Text>
            <Text style={styles.summary}>Coach: {form.coach_personality}</Text>
            <Text style={styles.summary}>Schedule: {form.schedule_days_per_week} days/week</Text>
            <Text style={styles.summary}>Lifestyle: {form.lifestyle}</Text>
            <Text style={styles.summary}>Injury: {form.injury_status}</Text>
          </View>
        )}

        <View style={styles.navRow}>
          <Pressable onPress={back} disabled={step === 1 || saving} style={[styles.backBtn, (step === 1 || saving) && styles.disabled]}>
            <Text style={styles.backBtnText}>Back</Text>
          </Pressable>

          {step < TOTAL_STEPS ? (
            <Pressable onPress={next} style={styles.nextBtn}>
              <Text style={styles.nextBtnText}>Next</Text>
            </Pressable>
          ) : (
            <Pressable onPress={submit} disabled={saving} style={[styles.nextBtn, saving && styles.disabled]}>
              <Text style={styles.nextBtnText}>{saving ? 'Saving...' : 'Finish'}</Text>
            </Pressable>
          )}
        </View>
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
    paddingHorizontal: 16,
    paddingBottom: 24
  },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: COLORS.card,
    marginBottom: 16,
    overflow: 'hidden'
  },
  progressFill: {
    height: 8,
    backgroundColor: COLORS.accent
  },
  card: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    backgroundColor: COLORS.card,
    padding: 16,
    gap: 16
  },
  stepText: {
    color: COLORS.subtext,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1
  },
  stepWrap: {
    gap: 12
  },
  title: {
    color: COLORS.text,
    fontSize: 24,
    fontWeight: '800'
  },
  subtitle: {
    color: COLORS.subtext,
    fontSize: 14
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    backgroundColor: COLORS.input,
    color: COLORS.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16
  },
  textArea: {
    minHeight: 96,
    textAlignVertical: 'top'
  },
  grid: {
    gap: 8
  },
  optionCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    backgroundColor: COLORS.input,
    padding: 12
  },
  optionCardActive: {
    borderColor: COLORS.accent,
    backgroundColor: '#2f2a10'
  },
  optionText: {
    color: COLORS.subtext,
    fontWeight: '600'
  },
  optionTextActive: {
    color: COLORS.accent
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
    fontSize: 13,
    fontWeight: '700'
  },
  pillTextActive: {
    color: COLORS.accent
  },
  summary: {
    color: COLORS.subtext,
    fontSize: 14
  },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10
  },
  backBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center'
  },
  backBtnText: {
    color: COLORS.subtext,
    fontWeight: '700'
  },
  nextBtn: {
    flex: 1,
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    paddingVertical: 12,
    alignItems: 'center'
  },
  nextBtnText: {
    color: '#000',
    fontWeight: '800'
  },
  disabled: {
    opacity: 0.6
  }
});
