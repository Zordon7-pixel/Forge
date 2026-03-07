import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import api from '../lib/api';

const COLORS = {
  overlay: 'rgba(0,0,0,0.75)',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
  input: '#1e2433'
};

const EFFORT = [1, 2, 3, 4, 5];
const LEGS = ['great', 'ok', 'tired', 'dead'];
const RECOVERY = ['fresh', 'normal', 'fatigued'];

export default function PostRunCheckIn({ visible, runId, onDone }) {
  const [effort, setEffort] = useState(null);
  const [legs, setLegs] = useState('');
  const [recovery, setRecovery] = useState('');
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setEffort(null);
    setLegs('');
    setRecovery('');
  };

  const submit = async () => {
    if (!effort || !legs || !recovery || !runId) return;

    try {
      setSaving(true);
      await api.post('/checkin/post-run', {
        runId,
        effort,
        legs,
        recovery
      });
    } catch {
      // Do not block user flow if post-run check-in fails.
    } finally {
      setSaving(false);
      reset();
      onDone?.();
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDone}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Post-Run Check-In</Text>
          <Text style={styles.subtitle}>Log how your run felt so tomorrow adapts better.</Text>

          <View style={styles.section}>
            <Text style={styles.label}>Overall effort</Text>
            <View style={styles.rowWrap}>
              {EFFORT.map((item) => (
                <Pressable
                  key={item}
                  onPress={() => setEffort(item)}
                  style={[styles.chip, effort === item && styles.chipActive]}
                >
                  <Text style={[styles.chipText, effort === item && styles.chipTextActive]}>{item}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>How legs felt</Text>
            <View style={styles.rowWrap}>
              {LEGS.map((item) => (
                <Pressable
                  key={item}
                  onPress={() => setLegs(item)}
                  style={[styles.chip, legs === item && styles.chipActive]}
                >
                  <Text style={[styles.chipText, legs === item && styles.chipTextActive]}>{item}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Recovery status</Text>
            <View style={styles.rowWrap}>
              {RECOVERY.map((item) => (
                <Pressable
                  key={item}
                  onPress={() => setRecovery(item)}
                  style={[styles.chip, recovery === item && styles.chipActive]}
                >
                  <Text style={[styles.chipText, recovery === item && styles.chipTextActive]}>{item}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.actionRow}>
            <Pressable onPress={() => { reset(); onDone?.(); }} style={[styles.btn, styles.secondaryBtn]}>
              <Text style={styles.secondaryText}>Skip</Text>
            </Pressable>
            <Pressable
              onPress={submit}
              disabled={saving || !effort || !legs || !recovery}
              style={[styles.btn, styles.primaryBtn, (saving || !effort || !legs || !recovery) && styles.disabled]}
            >
              <Text style={styles.primaryText}>{saving ? 'Saving...' : 'Submit'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: COLORS.overlay,
    justifyContent: 'flex-end'
  },
  sheet: {
    backgroundColor: COLORS.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
    gap: 12
  },
  title: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '800'
  },
  subtitle: {
    color: COLORS.subtext,
    fontSize: 13
  },
  section: {
    gap: 7
  },
  label: {
    color: COLORS.text,
    fontWeight: '700',
    fontSize: 14
  },
  rowWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  chip: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 999,
    backgroundColor: COLORS.input,
    paddingHorizontal: 11,
    paddingVertical: 7
  },
  chipActive: {
    borderColor: COLORS.accent,
    backgroundColor: '#2f2a10'
  },
  chipText: {
    color: COLORS.subtext,
    fontWeight: '700',
    textTransform: 'capitalize'
  },
  chipTextActive: {
    color: COLORS.accent
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4
  },
  btn: {
    flex: 1,
    borderRadius: 12,
    alignItems: 'center',
    paddingVertical: 12
  },
  primaryBtn: {
    backgroundColor: COLORS.accent
  },
  primaryText: {
    color: '#000',
    fontWeight: '800'
  },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.input
  },
  secondaryText: {
    color: COLORS.text,
    fontWeight: '700'
  },
  disabled: {
    opacity: 0.55
  }
});
