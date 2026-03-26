import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import api from '../lib/api';

const COLORS = {
  background: '#0a0a0a',
  card: '#141414',
  border: '#222',
  text: '#f6f6f6',
  muted: '#9ca3af',
  accent: '#00e5a0',
  input: '#101010',
  warningBg: '#3a210a',
  warningBorder: '#f59e0b',
  warningText: '#fbbf24',
  dangerBg: '#2c0b0e',
  dangerBorder: '#ef4444',
  dangerText: '#f87171',
  successBg: '#052e22',
  successBorder: '#10b981',
  successText: '#34d399'
};

const FITNESS_LEVELS = ['easy', 'moderate', 'high'];

function normalizeDigits(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function extractPlan(response) {
  return response?.data || null;
}

export default function ComebackPlanScreen() {
  const [form, setForm] = useState({
    injury_type: '',
    weeks_out: '',
    pt_milestone: '',
    target_race: '',
    target_weeks: '',
    current_fitness: 'moderate'
  });
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [plan, setPlan] = useState(null);

  const weekCards = useMemo(() => (Array.isArray(plan?.weeks) ? plan.weeks : []), [plan]);
  const generalWarnings = useMemo(
    () => (Array.isArray(plan?.general_warnings) ? plan.general_warnings.filter(Boolean) : []),
    [plan]
  );

  const submit = async () => {
    const nextErrors = {};

    const injuryType = form.injury_type.trim();
    if (!injuryType) nextErrors.injury_type = 'Required';
    if (injuryType.length > 100) nextErrors.injury_type = 'Max 100 characters';

    const weeksOut = Number(form.weeks_out);
    if (!form.weeks_out) nextErrors.weeks_out = 'Required';
    if (!Number.isInteger(weeksOut) || weeksOut < 1 || weeksOut > 52) {
      nextErrors.weeks_out = 'Enter 1-52';
    }

    const ptMilestone = form.pt_milestone.trim();
    if (!ptMilestone) nextErrors.pt_milestone = 'Required';
    if (ptMilestone.length > 200) nextErrors.pt_milestone = 'Max 200 characters';

    const targetRace = form.target_race.trim();
    const hasTargetWeeks = Boolean(form.target_weeks);
    const targetWeeks = hasTargetWeeks ? Number(form.target_weeks) : null;
    if (hasTargetWeeks && (!Number.isInteger(targetWeeks) || targetWeeks < 1 || targetWeeks > 104)) {
      nextErrors.target_weeks = 'Enter 1-104';
    }

    if (!FITNESS_LEVELS.includes(form.current_fitness)) {
      nextErrors.current_fitness = 'Choose a fitness level';
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      Alert.alert('Fix Form', 'Please correct the highlighted fields.');
      return;
    }

    try {
      setSubmitting(true);
      const response = await api.post('/comeback-plan', {
        injury_type: injuryType,
        weeks_out: weeksOut,
        pt_milestone: ptMilestone,
        target_race: targetRace || undefined,
        target_weeks: hasTargetWeeks ? targetWeeks : undefined,
        current_fitness: form.current_fitness
      });

      const nextPlan = extractPlan(response);
      if (!nextPlan || typeof nextPlan !== 'object') {
        Alert.alert('No Plan Returned', 'The server did not return a valid plan.');
        return;
      }
      setPlan(nextPlan);
    } catch (error) {
      Alert.alert('Plan Failed', error?.response?.data?.error || 'Could not build comeback plan.');
    } finally {
      setSubmitting(false);
    }
  };

  const setField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) {
      setErrors((prev) => ({ ...prev, [key]: undefined }));
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Build Your Comeback</Text>
      <Text style={styles.subheading}>Injury-aware return-to-training plan</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Injury Type</Text>
        <TextInput
          value={form.injury_type}
          onChangeText={(value) => setField('injury_type', value)}
          maxLength={100}
          placeholder="e.g. knee, shin splints, IT band"
          placeholderTextColor={COLORS.muted}
          style={[styles.input, errors.injury_type && styles.inputError]}
        />
        {errors.injury_type ? <Text style={styles.errorText}>{errors.injury_type}</Text> : null}

        <Text style={styles.label}>Weeks Out From Running</Text>
        <TextInput
          value={form.weeks_out}
          onChangeText={(value) => setField('weeks_out', normalizeDigits(value))}
          keyboardType="number-pad"
          placeholder="1-52"
          placeholderTextColor={COLORS.muted}
          style={[styles.input, errors.weeks_out && styles.inputError]}
        />
        {errors.weeks_out ? <Text style={styles.errorText}>{errors.weeks_out}</Text> : null}

        <Text style={styles.label}>PT Milestone</Text>
        <TextInput
          value={form.pt_milestone}
          onChangeText={(value) => setField('pt_milestone', value)}
          maxLength={200}
          multiline
          placeholder="e.g. pain-free walking, cleared for jogging"
          placeholderTextColor={COLORS.muted}
          style={[styles.input, styles.textArea, errors.pt_milestone && styles.inputError]}
        />
        {errors.pt_milestone ? <Text style={styles.errorText}>{errors.pt_milestone}</Text> : null}

        <Text style={styles.label}>Target Race (optional)</Text>
        <TextInput
          value={form.target_race}
          onChangeText={(value) => setField('target_race', value)}
          placeholder="e.g. 5K, half marathon"
          placeholderTextColor={COLORS.muted}
          style={styles.input}
        />

        <Text style={styles.label}>Target Weeks (optional)</Text>
        <TextInput
          value={form.target_weeks}
          onChangeText={(value) => setField('target_weeks', normalizeDigits(value))}
          keyboardType="number-pad"
          placeholder="e.g. 12"
          placeholderTextColor={COLORS.muted}
          style={[styles.input, errors.target_weeks && styles.inputError]}
        />
        {errors.target_weeks ? <Text style={styles.errorText}>{errors.target_weeks}</Text> : null}

        <Text style={styles.label}>Current Fitness</Text>
        <View style={styles.pickerRow}>
          {FITNESS_LEVELS.map((level) => {
            const active = form.current_fitness === level;
            return (
              <Pressable
                key={level}
                onPress={() => setField('current_fitness', level)}
                style={[styles.pickerOption, active && styles.pickerOptionActive]}
              >
                <Text style={[styles.pickerText, active && styles.pickerTextActive]}>{level}</Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable onPress={submit} disabled={submitting} style={[styles.submitBtn, submitting && styles.disabled]}>
          {submitting ? <ActivityIndicator size="small" color="#03120d" /> : <Text style={styles.submitText}>Build Plan</Text>}
        </Pressable>
      </View>

      {plan ? (
        <View style={styles.results}>
          <View style={styles.card}>
            <Text style={styles.planTitle}>{plan.plan_title || 'Comeback Plan'}</Text>
            {!!plan.summary && <Text style={styles.planSummary}>{plan.summary}</Text>}
          </View>

          {generalWarnings.length > 0 ? (
            <View style={[styles.callout, styles.warningCallout]}>
              <Text style={styles.calloutTitle}>General Warnings</Text>
              {generalWarnings.map((warning, idx) => (
                <Text key={`${warning}-${idx}`} style={styles.warningText}>
                  {`\u2022 ${warning}`}
                </Text>
              ))}
            </View>
          ) : null}

          {weekCards.map((week, index) => {
            const runs = Array.isArray(week?.runs) ? week.runs : [];
            const weekNumber = week?.week || index + 1;
            return (
              <View key={`week-${weekNumber}-${index}`} style={styles.card}>
                <Text style={styles.weekHeader}>
                  Week {weekNumber} {week?.theme ? `· ${week.theme}` : ''}
                </Text>

                <Text style={styles.metaLine}>Weekly Mileage Target: {week?.weekly_mileage_target ?? '--'}</Text>
                <Text style={styles.metaLine}>Milestone Check: {week?.milestone_check || '--'}</Text>

                <View style={styles.runsWrap}>
                  {runs.map((run, runIndex) => (
                    <View key={`${run?.day || 'day'}-${runIndex}`} style={styles.runRow}>
                      <Text style={styles.runMain}>
                        {run?.day || 'Day'} · {run?.type || 'run'} · {run?.duration_min ?? '--'} min
                      </Text>
                      {run?.notes ? <Text style={styles.runNotes}>{run.notes}</Text> : null}
                    </View>
                  ))}
                  {runs.length === 0 ? <Text style={styles.emptyText}>No runs listed for this week.</Text> : null}
                </View>

                {week?.warning ? (
                  <View style={[styles.callout, styles.warningWeekCallout]}>
                    <Text style={styles.warningWeekText}>{week.warning}</Text>
                  </View>
                ) : null}
              </View>
            );
          })}

          {!!plan.return_to_full_training_estimate && (
            <View style={[styles.callout, styles.successCallout]}>
              <Text style={styles.calloutTitle}>Return-To-Full-Training Estimate</Text>
              <Text style={styles.successText}>{plan.return_to_full_training_estimate}</Text>
            </View>
          )}
        </View>
      ) : null}
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
    paddingBottom: 28,
    gap: 12
  },
  heading: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: '800'
  },
  subheading: {
    color: COLORS.muted,
    fontSize: 13
  },
  card: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    backgroundColor: COLORS.card,
    padding: 14,
    gap: 10
  },
  label: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '700'
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
  inputError: {
    borderColor: '#ef4444'
  },
  textArea: {
    minHeight: 84,
    textAlignVertical: 'top'
  },
  errorText: {
    color: '#f87171',
    fontSize: 12,
    marginTop: -6
  },
  pickerRow: {
    flexDirection: 'row',
    gap: 8
  },
  pickerOption: {
    flex: 1,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 999,
    paddingVertical: 9,
    backgroundColor: COLORS.input,
    alignItems: 'center'
  },
  pickerOptionActive: {
    borderColor: COLORS.accent,
    backgroundColor: '#043225'
  },
  pickerText: {
    color: COLORS.muted,
    textTransform: 'capitalize',
    fontWeight: '700'
  },
  pickerTextActive: {
    color: COLORS.accent
  },
  submitBtn: {
    marginTop: 8,
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12
  },
  submitText: {
    color: '#03120d',
    fontWeight: '800'
  },
  disabled: {
    opacity: 0.7
  },
  results: {
    gap: 12
  },
  planTitle: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '800'
  },
  planSummary: {
    color: COLORS.muted,
    fontSize: 14,
    lineHeight: 20
  },
  weekHeader: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '800'
  },
  metaLine: {
    color: COLORS.muted,
    fontSize: 13
  },
  runsWrap: {
    gap: 8
  },
  runRow: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 10,
    backgroundColor: COLORS.input,
    gap: 4
  },
  runMain: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'capitalize'
  },
  runNotes: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 17
  },
  emptyText: {
    color: COLORS.muted,
    fontSize: 13
  },
  callout: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    gap: 6
  },
  calloutTitle: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.8
  },
  warningCallout: {
    backgroundColor: COLORS.warningBg,
    borderColor: COLORS.warningBorder
  },
  warningText: {
    color: COLORS.warningText,
    fontSize: 13,
    lineHeight: 18
  },
  warningWeekCallout: {
    backgroundColor: COLORS.dangerBg,
    borderColor: COLORS.dangerBorder
  },
  warningWeekText: {
    color: COLORS.dangerText,
    fontSize: 13,
    fontWeight: '700'
  },
  successCallout: {
    backgroundColor: COLORS.successBg,
    borderColor: COLORS.successBorder
  },
  successText: {
    color: COLORS.successText,
    fontSize: 14,
    fontWeight: '700'
  }
});
