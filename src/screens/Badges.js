import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Animated, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Award, Lock } from 'lucide-react-native';

import api from '../lib/api';
import AppHeader from '../components/AppHeader';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
};

function BadgeItem({ badge, progressMap, justUnlocked }) {
  const scale = useRef(new Animated.Value(1)).current;

  React.useEffect(() => {
    if (!justUnlocked) return;
    Animated.sequence([
      Animated.spring(scale, { toValue: 1.08, useNativeDriver: true, friction: 5 }),
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 6 }),
    ]).start();
  }, [justUnlocked, scale]);

  const earned = Boolean(badge?.earned || badge?.unlocked);
  const key = String(badge?.id || badge?.slug || badge?.name || 'badge');
  const entry = progressMap[key] || {};
  const progress = Number(entry.progress ?? badge?.progress ?? 0);
  const target = Number(entry.target ?? badge?.requirement_value ?? 1);
  const pct = target > 0 ? Math.min(100, (progress / target) * 100) : 0;

  return (
    <Animated.View style={[styles.badgeCard, { transform: [{ scale }] }, earned ? styles.badgeCardEarned : null]}>
      <View style={[styles.badgeIcon, earned ? styles.badgeIconEarned : null]}>
        <Award color={earned ? COLORS.accent : '#4b5563'} size={24} />
      </View>

      {!earned ? (
        <View style={styles.lockWrap}>
          <Lock color="#6b7280" size={12} />
        </View>
      ) : null}

      <Text style={[styles.badgeName, earned ? styles.badgeNameEarned : null]} numberOfLines={2}>{badge?.name || 'Badge'}</Text>
      <Text style={styles.badgeDesc} numberOfLines={2}>{badge?.description || 'Complete challenge requirements to unlock.'}</Text>

      <View style={styles.progressTrack}>
        <View style={[styles.progressBar, { width: `${pct}%` }]} />
      </View>
      <Text style={styles.progressText}>{Math.round(progress)} / {Math.max(1, Math.round(target))}</Text>
    </Animated.View>
  );
}

export default function Badges() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [badges, setBadges] = useState([]);
  const [progressMap, setProgressMap] = useState({});
  const [justUnlockedSet, setJustUnlockedSet] = useState(new Set());
  const earnedKeysRef = useRef(new Set());

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const [badgesRes, progressRes] = await Promise.all([
        api.get('/badges'),
        api.get('/badges/progress'),
      ]);

      const nextBadges = badgesRes?.data?.badges || badgesRes?.data || [];
      const progressArray = progressRes?.data?.progress || progressRes?.data || [];

      const nextMap = (Array.isArray(progressArray) ? progressArray : []).reduce((acc, item) => {
        const key = String(item?.badge_id || item?.id || item?.slug || item?.name || '');
        if (key) acc[key] = item;
        return acc;
      }, {});

      const unlockedNow = new Set();
      nextBadges.forEach((badge) => {
        const key = String(badge?.id || badge?.slug || badge?.name);
        if (!earnedKeysRef.current.has(key) && Boolean(badge?.earned || badge?.unlocked)) {
          unlockedNow.add(key);
        }
      });

      if (unlockedNow.size) {
        setJustUnlockedSet(unlockedNow);
      }

      setBadges(Array.isArray(nextBadges) ? nextBadges : []);
      setProgressMap(nextMap);
      earnedKeysRef.current = new Set(
        (Array.isArray(nextBadges) ? nextBadges : [])
          .filter((badge) => Boolean(badge?.earned || badge?.unlocked))
          .map((badge) => String(badge?.id || badge?.slug || badge?.name))
      );
    } catch (loadError) {
      setError(loadError?.response?.data?.message || 'Could not load badge gallery.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const earnedCount = badges.filter((badge) => Boolean(badge?.earned || badge?.unlocked)).length;

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl tintColor={COLORS.accent} refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} />}
    >
      <AppHeader />

      <View style={styles.heroCard}>
        <Text style={styles.title}>Badges</Text>
        <Text style={styles.subtitle}>{earnedCount} / {badges.length} unlocked</Text>
      </View>

      {!!error ? (
        <View style={styles.errorCard}><Text style={styles.errorText}>{error}</Text></View>
      ) : null}

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={COLORS.accent} />
          <Text style={styles.loadingText}>Loading badge gallery...</Text>
        </View>
      ) : null}

      {!loading && badges.length === 0 ? (
        <View style={styles.emptyCard}><Text style={styles.emptyText}>No badges available yet.</Text></View>
      ) : null}

      {!loading ? (
        <View style={styles.grid}>
          {badges.map((badge, idx) => {
            const key = String(badge?.id || badge?.slug || badge?.name || `badge-${idx}`);
            return (
              <BadgeItem
                key={key}
                badge={badge}
                progressMap={progressMap}
                justUnlocked={justUnlockedSet.has(key)}
              />
            );
          })}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 30,
  },
  heroCard: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
  },
  title: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '900',
  },
  subtitle: {
    color: COLORS.subtext,
    fontSize: 13,
    marginTop: 4,
  },
  errorCard: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: '#7f1d1d',
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  errorText: {
    color: '#fca5a5',
    fontSize: 13,
  },
  loadingWrap: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    gap: 8,
  },
  loadingText: {
    color: COLORS.subtext,
    fontSize: 13,
  },
  emptyCard: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 14,
  },
  emptyText: {
    color: COLORS.subtext,
    fontSize: 13,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  badgeCard: {
    width: '48%',
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 12,
    minHeight: 168,
  },
  badgeCardEarned: {
    borderColor: COLORS.accent,
    backgroundColor: 'rgba(234,179,8,0.08)',
  },
  badgeIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1f2937',
    marginBottom: 8,
  },
  badgeIconEarned: {
    backgroundColor: 'rgba(234,179,8,0.18)',
  },
  lockWrap: {
    position: 'absolute',
    top: 10,
    right: 10,
  },
  badgeName: {
    color: '#9ca3af',
    fontSize: 12,
    fontWeight: '800',
  },
  badgeNameEarned: {
    color: COLORS.accent,
  },
  badgeDesc: {
    color: COLORS.subtext,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 4,
    minHeight: 30,
  },
  progressTrack: {
    marginTop: 10,
    height: 6,
    borderRadius: 99,
    backgroundColor: '#1f2937',
    overflow: 'hidden',
  },
  progressBar: {
    height: 6,
    borderRadius: 99,
    backgroundColor: COLORS.accent,
  },
  progressText: {
    color: COLORS.subtext,
    fontSize: 10,
    marginTop: 4,
  },
});
