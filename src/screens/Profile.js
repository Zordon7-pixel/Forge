import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useContext, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { BookOpen, ChevronRight, Eye, HeartPulse, Settings as SettingsIcon } from 'lucide-react-native';

import api from '../lib/api';
import { AuthContext } from '../context/AuthContext';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
  success: '#22c55e',
  error: '#ef4444',
  input: '#1e2433'
};

const coachOptions = [
  { key: 'mentor', label: 'Mentor', description: 'Guidance and wisdom, no pressure' },
  { key: 'hype_coach', label: 'Hype Coach', description: 'High energy, keeps you fired up' },
  { key: 'drill_sergeant', label: 'Drill Sergeant', description: 'No excuses, maximum output' },
  { key: 'training_partner', label: 'Training Partner', description: 'Supportive, runs with you mentally' }
];

const goalOptions = [
  { key: 'get_faster', label: 'Get Faster' },
  { key: 'run_longer', label: 'Run Longer' },
  { key: 'lose_fat', label: 'Lose Fat' },
  { key: 'general_fitness', label: 'General Fitness' }
];

export default function Profile({ navigation }) {
  const insets = useSafeAreaInsets();
  const { signOut } = useContext(AuthContext);
  const [saving, setSaving] = useState(false);
  const [dismissMeta, setDismissMeta] = useState(false);
  const [stats, setStats] = useState({ total_runs: 0, total_miles: 0, this_week_miles: 0 });
  const [form, setForm] = useState({
    name: '',
    email: '',
    age: '',
    weight_lbs: '',
    sex: 'male',
    fitness_level: 'beginner',
    goals: ['general_fitness'],
    weekly_miles: '',
    coach_personality: 'mentor',
    injury_mode: false,
    injury_status: 'none',
    injury_detail: ''
  });

  const initials = useMemo(() => {
    const name = (form.name || 'User').trim();
    const pieces = name.split(' ').filter(Boolean);
    if (pieces.length === 1) return pieces[0][0].toUpperCase();
    return `${pieces[0][0]}${pieces[1][0]}`.toUpperCase();
  }, [form.name]);

  const loadProfile = useCallback(async () => {
    const [meRes, statsRes] = await Promise.all([
      api.get('/auth/me').catch(() => ({ data: {} })),
      api.get('/auth/me/stats').catch(() => ({ data: {} }))
    ]);

    const user = meRes?.data?.user || meRes?.data || {};
    const statsData = statsRes?.data || {};

    setForm((prev) => ({
      ...prev,
      name: user.name || '',
      email: user.email || '',
      age: user.age === null || user.age === undefined ? '' : String(user.age),
      weight_lbs: user.weight_lbs === null || user.weight_lbs === undefined ? '' : String(user.weight_lbs),
      sex: user.sex || 'male',
      fitness_level: user.fitness_level || 'beginner',
      goals: Array.isArray(user.goals)
        ? user.goals
        : user.primary_goal
          ? [user.primary_goal]
          : ['general_fitness'],
      weekly_miles: user.weekly_miles === null || user.weekly_miles === undefined ? '' : String(user.weekly_miles),
      coach_personality: user.coach_personality || 'mentor',
      injury_mode: Boolean(user.injury_mode),
      injury_status: user.injury_status || 'none',
      injury_detail: user.injury_detail || ''
    }));

    setStats({
      total_runs: Number(statsData.total_runs ?? statsData?.all?.runs ?? 0),
      total_miles: Number(statsData.total_miles ?? statsData?.all?.miles ?? 0),
      this_week_miles: Number(statsData.this_week_miles ?? statsData?.week?.miles ?? 0)
    });
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadProfile();
    }, [loadProfile])
  );

  const updateForm = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleGoal = (goalKey) => {
    setForm((prev) => {
      const exists = prev.goals.includes(goalKey);
      return {
        ...prev,
        goals: exists ? prev.goals.filter((goal) => goal !== goalKey) : [...prev.goals, goalKey]
      };
    });
  };

  const onSave = async () => {
    try {
      setSaving(true);
      await Promise.all([
        api.put('/auth/me/profile', {
          name: form.name,
          age: form.age === '' ? null : Number(form.age),
          weight_lbs: form.weight_lbs === '' ? null : Number(form.weight_lbs),
          sex: form.sex,
          fitness_level: form.fitness_level,
          goals: form.goals,
          primary_goal: form.goals[0] || 'general_fitness',
          weekly_miles: form.weekly_miles === '' ? null : Number(form.weekly_miles),
          coach_personality: form.coach_personality,
          injury_status: form.injury_mode ? form.injury_status : 'none',
          injury_detail: form.injury_mode ? form.injury_detail : ''
        }),
        api.post('/auth/injury', {
          injury_mode: form.injury_mode,
          injury_description: form.injury_mode ? form.injury_detail : '',
          injury_date: '',
          injury_limitations: ''
        })
      ]);
      Alert.alert('Saved', 'Profile updated.');
      loadProfile();
    } catch (error) {
      Alert.alert('Save Failed', error?.response?.data?.error || 'Could not save profile.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView style={[styles.container, { paddingTop: insets.top }]} contentContainerStyle={styles.content}>
      <View style={styles.headerCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <Text style={styles.name}>{form.name || 'Athlete'}</Text>
        <Text style={styles.email}>{form.email || '--'}</Text>

        <View style={styles.statsRow}>
          <View style={styles.statCell}>
            <Text style={styles.statValue}>{stats.total_runs}</Text>
            <Text style={styles.statLabel}>Total Runs</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statCell}>
            <Text style={styles.statValue}>{stats.total_miles.toFixed(1)}</Text>
            <Text style={styles.statLabel}>Total Miles</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statCell}>
            <Text style={styles.statValue}>{stats.this_week_miles.toFixed(1)}</Text>
            <Text style={styles.statLabel}>This Week</Text>
          </View>
        </View>
      </View>

      <View style={styles.sectionCard}>
        <Text style={styles.sectionLabel}>IDENTITY</Text>

        <TextInput
          value={form.name}
          onChangeText={(v) => updateForm('name', v)}
          style={styles.input}
          placeholder="Name"
          placeholderTextColor="#94a3b8"
        />
        <TextInput
          value={form.email}
          onChangeText={(v) => updateForm('email', v)}
          style={styles.input}
          placeholder="Email"
          keyboardType="email-address"
          placeholderTextColor="#94a3b8"
        />

        <View style={styles.rowGap}>
          <TextInput
            value={form.age}
            onChangeText={(v) => updateForm('age', v)}
            style={[styles.input, styles.halfInput]}
            keyboardType="numeric"
            placeholder="Age"
            placeholderTextColor="#94a3b8"
          />
          <TextInput
            value={form.weight_lbs}
            onChangeText={(v) => updateForm('weight_lbs', v)}
            style={[styles.input, styles.halfInput]}
            keyboardType="numeric"
            placeholder="Weight (lbs)"
            placeholderTextColor="#94a3b8"
          />
        </View>

        <View style={styles.rowGap}>
          {['male', 'female'].map((sex) => (
            <Pressable
              key={sex}
              onPress={() => updateForm('sex', sex)}
              style={[styles.togglePill, form.sex === sex && styles.togglePillActive, styles.halfPill]}
            >
              <Text style={[styles.toggleText, form.sex === sex && styles.toggleTextActive]}>
                {sex === 'male' ? 'Male' : 'Female'}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.rowWrap}>
          {['beginner', 'intermediate', 'advanced'].map((level) => (
            <Pressable
              key={level}
              onPress={() => updateForm('fitness_level', level)}
              style={[styles.togglePill, form.fitness_level === level && styles.togglePillActive]}
            >
              <Text style={[styles.toggleText, form.fitness_level === level && styles.toggleTextActive]}>
                {level[0].toUpperCase() + level.slice(1)}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.rowWrap}>
          {goalOptions.map((goal) => (
            <Pressable
              key={goal.key}
              onPress={() => toggleGoal(goal.key)}
              style={[styles.togglePill, form.goals.includes(goal.key) && styles.togglePillActive]}
            >
              <Text style={[styles.toggleText, form.goals.includes(goal.key) && styles.toggleTextActive]}>
                {goal.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.rowGapCenter}>
          <TextInput
            value={form.weekly_miles}
            onChangeText={(v) => updateForm('weekly_miles', v)}
            style={[styles.input, styles.flexInput]}
            keyboardType="numeric"
            placeholder="Miles/week"
            placeholderTextColor="#94a3b8"
          />
          <Text style={styles.subtleText}>mi/week</Text>
        </View>
      </View>

      <View style={styles.sectionCard}>
        <Text style={styles.sectionLabel}>YOUR COACH</Text>
        <View style={styles.coachGrid}>
          {coachOptions.map((coach) => {
            const selected = form.coach_personality === coach.key;
            return (
              <Pressable
                key={coach.key}
                onPress={() => updateForm('coach_personality', coach.key)}
                style={[styles.coachCard, selected && styles.coachCardSelected]}
              >
                <Text style={[styles.coachTitle, selected && styles.coachTitleSelected]}>{coach.label}</Text>
                <Text style={styles.coachDescription}>{coach.description}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.sectionCard}>
        <Text style={styles.sectionLabel}>INJURY MODE</Text>
        <View style={styles.injuryHeader}>
          <Text style={styles.subtleText}>Adjust training around injuries and current limitations.</Text>
          <Switch
            value={form.injury_mode}
            onValueChange={(value) => updateForm('injury_mode', value)}
            trackColor={{ false: '#2c3345', true: '#EAB308' }}
            thumbColor={form.injury_mode ? '#0f1117' : '#94a3b8'}
          />
        </View>

        {form.injury_mode && (
          <>
            <View style={styles.rowWrap}>
              {['none', 'recovering', 'chronic'].map((status) => (
                <Pressable
                  key={status}
                  onPress={() => updateForm('injury_status', status)}
                  style={[styles.togglePill, form.injury_status === status && styles.togglePillActive]}
                >
                  <Text style={[styles.toggleText, form.injury_status === status && styles.toggleTextActive]}>
                    {status === 'none' ? 'None' : status === 'recovering' ? 'Recovering' : 'Chronic'}
                  </Text>
                </Pressable>
              ))}
            </View>

            <TextInput
              value={form.injury_detail}
              onChangeText={(v) => updateForm('injury_detail', v)}
              style={[styles.input, styles.textArea]}
              placeholder="Injury details"
              placeholderTextColor="#94a3b8"
              multiline
            />
          </>
        )}
      </View>

      <Pressable onPress={onSave} style={styles.saveButton} disabled={saving}>
        <Text style={styles.saveText}>{saving ? 'Saving...' : 'Save'}</Text>
      </Pressable>

      <View style={styles.menuCard}>
        <Pressable style={styles.menuRow} onPress={() => navigation.navigate('Settings')}>
          <View style={styles.menuLeft}>
            <SettingsIcon size={16} color="#94a3b8" />
            <Text style={styles.menuText}>Settings</Text>
          </View>
          <ChevronRight size={16} color="#94a3b8" />
        </Pressable>

        <Pressable style={styles.menuRow} onPress={() => navigation.navigate('Journal')}>
          <View style={styles.menuLeft}>
            <BookOpen size={16} color="#94a3b8" />
            <Text style={styles.menuText}>Journal</Text>
          </View>
          <ChevronRight size={16} color="#94a3b8" />
        </Pressable>
      </View>

      <View style={styles.sectionCard}>
        <Text style={styles.sectionLabel}>HEALTH</Text>
        <Pressable style={styles.menuRow}>
          <View style={styles.menuLeft}>
            <HeartPulse size={16} color="#94a3b8" />
            <Text style={styles.menuText}>Injury Log</Text>
          </View>
          <ChevronRight size={16} color="#94a3b8" />
        </Pressable>
      </View>

      {!dismissMeta && (
        <View style={styles.sectionCard}>
          <View style={styles.deviceHeader}>
            <View style={styles.deviceBrand}>
              <View style={styles.deviceIconWrap}>
                <Eye size={15} color="#EAB308" />
              </View>
              <View>
                <Text style={styles.deviceTitle}>Meta Ray-Ban Glasses</Text>
                <Text style={styles.deviceSub}>Smart glasses integration</Text>
              </View>
            </View>
            <View style={styles.comingSoonBadge}>
              <Text style={styles.comingSoonText}>Coming Soon</Text>
            </View>
          </View>

          <Text style={styles.deviceDescription}>
            When Meta opens their API, FORGE will sync activity detection, step tracking, coaching, and POV capture.
          </Text>

          <View style={styles.deviceActions}>
            <Pressable style={styles.disabledButton} disabled>
              <Text style={styles.disabledButtonText}>Connect Meta Account</Text>
            </Pressable>
            <Pressable style={styles.dismissButton} onPress={() => setDismissMeta(true)}>
              <Text style={styles.dismissText}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      )}

      <Pressable onPress={signOut} style={styles.logoutButton}>
        <Text style={styles.logoutText}>Log Out</Text>
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
    paddingTop: 14,
    paddingBottom: 30
  },
  headerCard: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
    marginBottom: 12
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: COLORS.accent,
    justifyContent: 'center',
    alignItems: 'center'
  },
  avatarText: {
    color: '#000000',
    fontWeight: '800',
    fontSize: 20
  },
  name: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: '800',
    marginTop: 10
  },
  email: {
    color: COLORS.subtext,
    fontSize: 13,
    marginTop: 3
  },
  statsRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop: 12
  },
  statCell: {
    flex: 1,
    alignItems: 'center'
  },
  statDivider: {
    width: 1,
    height: 30,
    backgroundColor: COLORS.border
  },
  statValue: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700'
  },
  statLabel: {
    color: COLORS.subtext,
    fontSize: 11,
    marginTop: 2
  },
  sectionCard: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    marginBottom: 12
  },
  sectionLabel: {
    color: COLORS.subtext,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 10
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.input,
    borderRadius: 10,
    color: COLORS.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 10
  },
  textArea: {
    minHeight: 86,
    textAlignVertical: 'top'
  },
  rowGap: {
    flexDirection: 'row',
    gap: 8
  },
  rowGapCenter: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center'
  },
  halfInput: {
    flex: 1
  },
  flexInput: {
    flex: 1,
    marginBottom: 0
  },
  subtleText: {
    color: COLORS.subtext,
    fontSize: 12
  },
  rowWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10
  },
  togglePill: {
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  halfPill: {
    flex: 1,
    alignItems: 'center'
  },
  togglePillActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent
  },
  toggleText: {
    color: COLORS.subtext,
    fontSize: 12,
    fontWeight: '600'
  },
  toggleTextActive: {
    color: '#000000'
  },
  coachGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  coachCard: {
    width: '48%',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 10,
    backgroundColor: COLORS.input
  },
  coachCardSelected: {
    borderColor: COLORS.accent
  },
  coachTitle: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4
  },
  coachTitleSelected: {
    color: COLORS.accent
  },
  coachDescription: {
    color: COLORS.subtext,
    fontSize: 11,
    lineHeight: 16
  },
  injuryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    gap: 8
  },
  saveButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    alignItems: 'center',
    paddingVertical: 13,
    marginBottom: 12
  },
  saveText: {
    color: '#000000',
    fontSize: 15,
    fontWeight: '700'
  },
  menuCard: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    marginBottom: 12
  },
  menuRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border
  },
  menuLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  menuText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600'
  },
  deviceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start'
  },
  deviceBrand: {
    flexDirection: 'row',
    gap: 8,
    flex: 1
  },
  deviceIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.accent,
    backgroundColor: '#1e2433'
  },
  deviceTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700'
  },
  deviceSub: {
    color: COLORS.subtext,
    fontSize: 11,
    marginTop: 1
  },
  comingSoonBadge: {
    borderWidth: 1,
    borderColor: COLORS.accent,
    borderRadius: 7,
    paddingHorizontal: 8,
    paddingVertical: 4
  },
  comingSoonText: {
    color: COLORS.accent,
    fontSize: 10,
    fontWeight: '700'
  },
  deviceDescription: {
    color: COLORS.subtext,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 10,
    marginBottom: 10
  },
  deviceActions: {
    flexDirection: 'row',
    gap: 8
  },
  disabledButton: {
    flex: 1,
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    opacity: 0.6
  },
  disabledButtonText: {
    color: COLORS.subtext,
    fontSize: 13,
    fontWeight: '600'
  },
  dismissButton: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12
  },
  dismissText: {
    color: COLORS.subtext,
    fontSize: 12
  },
  logoutButton: {
    alignItems: 'center',
    paddingVertical: 12
  },
  logoutText: {
    color: COLORS.error,
    fontSize: 15,
    fontWeight: '700'
  }
});
