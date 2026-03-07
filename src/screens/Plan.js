import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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

const normalizeType = (value) => {
  const key = String(value || '').toLowerCase();
  if (key.includes('run')) return 'run';
  if (key.includes('lift') || key.includes('strength')) return 'lift';
  return 'rest';
};

const getDayLabel = (session, index) => session?.day || ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][index] || `Day ${index + 1}`;

const sessionLabel = (session = {}) => {
  const type = normalizeType(session.type);
  if (type === 'rest') return 'Rest Day';
  if (type === 'run') {
    const miles = Number(session.distance_miles || session.distance || 0);
    return miles > 0 ? `${session.title || 'Run'} · ${miles.toFixed(1)} mi` : session.title || 'Run Session';
  }
  return session.title || 'Strength Session';
};

export default function Plan({ navigation }) {
  const [loading, setLoading] = useState(true);
  const [plan, setPlan] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [updating, setUpdating] = useState(false);

  const loadPlan = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/plans/current').catch(() => ({ data: {} }));
      const payload = response?.data || {};
      const currentPlan = payload?.plan || payload;
      const weekSessions = payload?.sessions || currentPlan?.sessions || currentPlan?.week?.sessions || [];

      setPlan(currentPlan || null);
      setSessions(Array.isArray(weekSessions) ? weekSessions : []);
      setSelected((prev) => {
        if (!prev) return Array.isArray(weekSessions) ? weekSessions[0] || null : null;
        return (Array.isArray(weekSessions) ? weekSessions : []).find((item) => String(item.id) === String(prev.id)) || weekSessions[0] || null;
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadPlan();
    }, [loadPlan])
  );

  const completedSet = useMemo(() => {
    const ids = new Set();
    sessions.forEach((session) => {
      if (
        session.completed === true ||
        Number(session.completed) === 1 ||
        session.status === 'complete' ||
        session.status === 'completed'
      ) {
        ids.add(String(session.id));
      }
    });
    return ids;
  }, [sessions]);

  const compliance = useMemo(() => {
    const planned = sessions.filter((item) => normalizeType(item.type) !== 'rest').length;
    const completed = sessions.filter((item) => normalizeType(item.type) !== 'rest' && completedSet.has(String(item.id))).length;
    const score = planned > 0 ? Math.round((completed / planned) * 100) : 0;
    return { planned, completed, score };
  }, [sessions, completedSet]);

  const patchLocalStatus = (sessionId, complete) => {
    setSessions((prev) => prev.map((item) => (
      String(item.id) === String(sessionId)
        ? { ...item, completed: complete, status: complete ? 'completed' : 'planned' }
        : item
    )));
  };

  const toggleSession = async (session, complete) => {
    if (!session?.id || normalizeType(session.type) === 'rest') return;

    setUpdating(true);
    patchLocalStatus(session.id, complete);

    try {
      await api.put('/plans/my/progress', complete
        ? { completed_session_id: session.id, current_week: Number(plan?.current_week || 1) }
        : { unset_session_id: session.id, current_week: Number(plan?.current_week || 1) }
      );
    } catch {
      patchLocalStatus(session.id, !complete);
      Alert.alert('Update Failed', 'Could not update session status.');
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.centerWrap}>
        <Text style={styles.muted}>Loading plan...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.headerCard}>
        <Text style={styles.title}>Training Plan</Text>
        <Text style={styles.subtitle}>{plan?.name || 'Weekly Plan'}</Text>

        <View style={styles.complianceWrap}>
          <Text style={styles.complianceText}>Compliance: {compliance.score}%</Text>
          <Text style={styles.complianceSub}>{compliance.completed}/{compliance.planned} sessions completed</Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.min(100, compliance.score)}%` }]} />
          </View>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>This Week</Text>
        {sessions.map((session, index) => {
          const type = normalizeType(session.type);
          const isSelected = String(selected?.id) === String(session.id);
          const isDone = completedSet.has(String(session.id));

          return (
            <Pressable
              key={`${session.id || index}`}
              style={[styles.dayRow, isSelected && styles.dayRowActive]}
              onPress={() => setSelected(session)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.dayLabel}>{getDayLabel(session, index)}</Text>
                <Text style={styles.daySub}>{sessionLabel(session)}</Text>
              </View>

              <View style={styles.rightPills}>
                <View style={[styles.typePill, type === 'run' ? styles.runPill : type === 'lift' ? styles.liftPill : styles.restPill]}>
                  <Text style={styles.typePillText}>{type.toUpperCase()}</Text>
                </View>
                {type !== 'rest' && isDone && <Text style={styles.done}>Done</Text>}
              </View>
            </Pressable>
          );
        })}
      </View>

      {selected && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Workout Details</Text>
          <Text style={styles.detailTitle}>{selected.title || sessionLabel(selected)}</Text>
          <Text style={styles.detailText}>Type: {normalizeType(selected.type).toUpperCase()}</Text>
          {selected.distance_miles ? <Text style={styles.detailText}>Distance: {Number(selected.distance_miles).toFixed(1)} mi</Text> : null}
          {selected.sets ? <Text style={styles.detailText}>Sets: {selected.sets}</Text> : null}
          {selected.reps ? <Text style={styles.detailText}>Reps: {selected.reps}</Text> : null}
          {selected.notes ? <Text style={styles.detailText}>Notes: {selected.notes}</Text> : null}

          <View style={styles.actionRow}>
            {normalizeType(selected.type) !== 'rest' && (
              <>
                <Pressable
                  disabled={updating}
                  style={[styles.actionBtn, styles.completeBtn]}
                  onPress={() => toggleSession(selected, true)}
                >
                  <Text style={styles.actionBtnText}>Mark Complete</Text>
                </Pressable>
                <Pressable
                  disabled={updating}
                  style={[styles.actionBtn, styles.incompleteBtn]}
                  onPress={() => toggleSession(selected, false)}
                >
                  <Text style={styles.incompleteText}>Mark Incomplete</Text>
                </Pressable>
              </>
            )}
          </View>

          {normalizeType(selected.type) === 'lift' && Array.isArray(selected.exercises) && selected.exercises.length > 0 && (
            <Pressable
              style={[styles.actionBtn, styles.launchWorkoutBtn]}
              onPress={() => navigation.navigate('ActiveWorkout', {
                workoutName: selected.title || 'Strength Session',
                exercises: selected.exercises
              })}
            >
              <Text style={styles.actionBtnText}>Start Workout Session</Text>
            </Pressable>
          )}
        </View>
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
    padding: 16,
    gap: 12,
    paddingBottom: 24
  },
  centerWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.background
  },
  muted: {
    color: COLORS.subtext,
    fontSize: 15
  },
  headerCard: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    padding: 16,
    gap: 8
  },
  title: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '800'
  },
  subtitle: {
    color: COLORS.subtext,
    fontSize: 14
  },
  complianceWrap: {
    marginTop: 4,
    gap: 4
  },
  complianceText: {
    color: COLORS.text,
    fontWeight: '700',
    fontSize: 16
  },
  complianceSub: {
    color: COLORS.subtext,
    fontSize: 12
  },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: COLORS.input,
    overflow: 'hidden',
    marginTop: 2
  },
  progressFill: {
    height: 8,
    backgroundColor: COLORS.accent
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
    color: COLORS.subtext,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8
  },
  dayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 12,
    backgroundColor: COLORS.input
  },
  dayRowActive: {
    borderColor: COLORS.accent
  },
  dayLabel: {
    color: COLORS.text,
    fontWeight: '700',
    fontSize: 14
  },
  daySub: {
    color: COLORS.subtext,
    fontSize: 12,
    marginTop: 2
  },
  rightPills: {
    alignItems: 'flex-end',
    gap: 6
  },
  typePill: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3
  },
  runPill: {
    backgroundColor: 'rgba(59,130,246,0.18)'
  },
  liftPill: {
    backgroundColor: 'rgba(234,179,8,0.18)'
  },
  restPill: {
    backgroundColor: 'rgba(148,163,184,0.18)'
  },
  typePillText: {
    color: COLORS.text,
    fontSize: 10,
    fontWeight: '800'
  },
  done: {
    color: COLORS.success,
    fontSize: 11,
    fontWeight: '700'
  },
  detailTitle: {
    color: COLORS.text,
    fontWeight: '700',
    fontSize: 16
  },
  detailText: {
    color: COLORS.subtext,
    fontSize: 13
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 6
  },
  actionBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center'
  },
  completeBtn: {
    backgroundColor: COLORS.accent
  },
  incompleteBtn: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.input
  },
  actionBtnText: {
    color: '#000',
    fontWeight: '800',
    fontSize: 13
  },
  incompleteText: {
    color: COLORS.text,
    fontWeight: '700',
    fontSize: 13
  },
  launchWorkoutBtn: {
    marginTop: 6
  }
});
