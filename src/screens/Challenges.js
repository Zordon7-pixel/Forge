import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Award } from 'lucide-react-native';

import api from '../lib/api';

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

const parseDate = (raw) => {
  if (!raw) return null;
  const candidate = String(raw).length === 10 ? `${raw}T12:00:00` : raw;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export default function Challenges() {
  const [tab, setTab] = useState('Challenges');
  const [refreshing, setRefreshing] = useState(false);
  const [challenges, setChallenges] = useState([]);
  const [badges, setBadges] = useState([]);
  const [prs, setPrs] = useState([]);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [challengesRes, badgesRes, prsRes, runsRes] = await Promise.all([
        api.get('/challenges').catch(() => ({ data: { challenges: [] } })),
        api.get('/badges').catch(() => ({ data: { badges: [] } })),
        api.get('/prs').catch(() => ({ data: [] })),
        api.get('/runs').catch(() => ({ data: [] }))
      ]);

      const challengeList = challengesRes?.data?.challenges || [];
      const badgeList = badgesRes?.data?.badges || badgesRes?.data || [];
      const prList = Array.isArray(prsRes?.data) ? prsRes.data : prsRes?.data?.prs || [];

      const runs = Array.isArray(runsRes?.data) ? runsRes.data : runsRes?.data?.runs || [];
      const computedPrs = [
        {
          distance: 'Fastest Pace',
          pace: runs
            .filter((run) => Number(run.distance_miles ?? run.distance) > 0 && Number(run.duration_seconds ?? run.duration) > 0)
            .map((run) => ({
              id: run.id,
              date: run.date || run.created_at,
              pace: Number(run.duration_seconds ?? run.duration) / 60 / Number(run.distance_miles ?? run.distance)
            }))
            .sort((a, b) => a.pace - b.pace)[0]
        }
      ].filter((item) => item.pace);

      setChallenges(challengeList);
      setBadges(Array.isArray(badgeList) ? badgeList : []);
      setPrs(prList.length ? prList : computedPrs);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const monthlyGoal = useMemo(() => {
    const goalChallenge = challenges.find((challenge) => String(challenge.name || '').toLowerCase().includes('monthly'));
    if (goalChallenge) {
      const target = Number(goalChallenge.target_value || goalChallenge.goal || 0);
      const progress = Number(goalChallenge.progress || 0);
      return {
        target,
        progress,
        pct: target > 0 ? Math.min(100, Math.round((progress / target) * 100)) : 0
      };
    }
    return {
      target: 100,
      progress: 0,
      pct: 0
    };
  }, [challenges]);

  const myChallenges = useMemo(
    () => challenges.filter((challenge) => challenge.joined || challenge.is_joined),
    [challenges]
  );

  const browseChallenges = useMemo(
    () => challenges.filter((challenge) => !(challenge.joined || challenge.is_joined)),
    [challenges]
  );

  const joinChallenge = async (challengeId) => {
    try {
      await api.post(`/challenges/${challengeId}/join`, {});
      load();
    } catch {
      // no-op to keep flow lightweight
    }
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl tintColor="#EAB308" refreshing={refreshing} onRefresh={load} />}
    >
      <Text style={styles.title}>Challenges</Text>

      <View style={styles.tabRow}>
        {['Challenges', 'Badges', 'PR Wall'].map((value) => (
          <Pressable key={value} onPress={() => setTab(value)} style={[styles.tab, tab === value && styles.tabActive]}>
            <Text style={[styles.tabText, tab === value && styles.tabTextActive]}>{value}</Text>
          </Pressable>
        ))}
      </View>

      {tab === 'Challenges' && (
        <>
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>Monthly Goal</Text>
            <Text style={styles.metricText}>
              {monthlyGoal.progress} / {monthlyGoal.target} miles
            </Text>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${monthlyGoal.pct}%` }]} />
            </View>
          </View>

          <Text style={styles.sectionTitle}>Browse Challenges</Text>
          {browseChallenges.map((challenge, index) => {
            const target = Number(challenge.target_value || challenge.goal || 1);
            const progress = Number(challenge.progress || 0);
            const pct = Math.min(100, Math.round((progress / Math.max(target, 1)) * 100));
            return (
              <View key={`challenge-${challenge.id || index}`} style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.challengeName}>{challenge.name || 'Challenge'}</Text>
                  <View style={styles.typeBadge}>
                    <Text style={styles.typeText}>{challenge.type || 'general'}</Text>
                  </View>
                </View>
                <Text style={styles.challengeMeta}>Target: {target}</Text>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${pct}%` }]} />
                </View>
                <Pressable style={styles.joinButton} onPress={() => joinChallenge(challenge.id)}>
                  <Text style={styles.joinButtonText}>Join</Text>
                </Pressable>
              </View>
            );
          })}

          <Text style={styles.sectionTitle}>My Challenges</Text>
          {myChallenges.map((challenge, index) => {
            const target = Number(challenge.target_value || challenge.goal || 1);
            const progress = Number(challenge.progress || 0);
            const pct = Math.min(100, Math.round((progress / Math.max(target, 1)) * 100));
            return (
              <View key={`my-challenge-${challenge.id || index}`} style={styles.card}>
                <Text style={styles.challengeName}>{challenge.name || 'Challenge'}</Text>
                <Text style={styles.challengeMeta}>{progress} / {target}</Text>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${pct}%` }]} />
                </View>
              </View>
            );
          })}
          {!myChallenges.length && <Text style={styles.emptyText}>No joined challenges yet.</Text>}
        </>
      )}

      {tab === 'Badges' && (
        <View style={styles.badgesGrid}>
          {badges.map((badge, index) => {
            const earnedDate = parseDate(badge.earned_at || badge.earned_date);
            return (
              <View key={`badge-${badge.id || index}`} style={styles.badgeCard}>
                <View style={styles.badgeIconCircle}>
                  <Award size={16} color="#EAB308" />
                </View>
                <Text style={styles.badgeName}>{badge.name || 'Badge'}</Text>
                <Text style={styles.badgeDescription}>{badge.description || ''}</Text>
                <Text style={[styles.badgeStatus, earnedDate ? styles.badgeEarned : styles.badgeLocked]}>
                  {earnedDate ? earnedDate.toLocaleDateString() : 'Locked'}
                </Text>
              </View>
            );
          })}
          {!badges.length && <Text style={styles.emptyText}>No badges available yet.</Text>}
        </View>
      )}

      {tab === 'PR Wall' && (
        <>
          {prs.map((pr, index) => (
            <View key={`pr-${pr.id || index}`} style={styles.card}>
              <Text style={styles.challengeName}>{pr.distance || pr.name || 'PR'}</Text>
              <Text style={styles.challengeMeta}>
                Time: {pr.time || '--'} | Pace:{' '}
                {pr.pace
                  ? typeof pr.pace === 'number'
                    ? `${Math.floor(pr.pace)}:${String(Math.round((pr.pace % 1) * 60)).padStart(2, '0')}/mi`
                    : pr.pace
                  : '--'}
              </Text>
              <Text style={styles.challengeMeta}>Achieved: {parseDate(pr.date || pr.achieved_at)?.toLocaleDateString() || '--'}</Text>
            </View>
          ))}
          {!prs.length && <Text style={styles.emptyText}>No PR data yet.</Text>}
        </>
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
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24
  },
  title: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 10
  },
  tabRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    flexWrap: 'wrap'
  },
  tab: {
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7
  },
  tabActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent
  },
  tabText: {
    color: COLORS.subtext,
    fontSize: 12,
    fontWeight: '700'
  },
  tabTextActive: {
    color: '#000000'
  },
  card: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 12,
    marginBottom: 10
  },
  sectionLabel: {
    color: COLORS.subtext,
    fontSize: 12
  },
  sectionTitle: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 8,
    marginTop: 4
  },
  metricText: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700',
    marginTop: 4
  },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: COLORS.input,
    marginTop: 8,
    overflow: 'hidden'
  },
  progressFill: {
    height: 8,
    backgroundColor: COLORS.accent
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  challengeName: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700'
  },
  challengeMeta: {
    color: COLORS.subtext,
    fontSize: 12,
    marginTop: 4
  },
  typeBadge: {
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3
  },
  typeText: {
    color: COLORS.subtext,
    fontSize: 10,
    fontWeight: '700'
  },
  joinButton: {
    marginTop: 10,
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    alignItems: 'center',
    paddingVertical: 10
  },
  joinButtonText: {
    color: '#000000',
    fontWeight: '700',
    fontSize: 13
  },
  emptyText: {
    color: COLORS.subtext,
    fontSize: 12,
    marginBottom: 10
  },
  badgesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  badgeCard: {
    width: '48%',
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 12
  },
  badgeIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8
  },
  badgeName: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '700'
  },
  badgeDescription: {
    color: COLORS.subtext,
    fontSize: 11,
    marginTop: 4,
    minHeight: 32
  },
  badgeStatus: {
    fontSize: 11,
    marginTop: 8,
    fontWeight: '700'
  },
  badgeEarned: {
    color: COLORS.success
  },
  badgeLocked: {
    color: COLORS.subtext
  }
});
