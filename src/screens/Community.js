import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Heart, MessageCircle } from 'lucide-react-native';

import api from '../lib/api';
import AppHeader from '../components/AppHeader';

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

const QUOTES = [
  'The body achieves what the mind believes.',
  'Small daily progress creates big race-day results.',
  'Discipline beats motivation on hard days.',
  'Consistency compounds faster than intensity.'
];

const parseDate = (raw) => {
  if (!raw) return null;
  const candidate = String(raw).length === 10 ? `${raw}T12:00:00` : raw;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const getInitials = (name) => {
  const parts = String(name || 'Athlete').trim().split(' ').filter(Boolean);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
};

export default function Community() {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState('Feed');
  const [refreshing, setRefreshing] = useState(false);
  const [feed, setFeed] = useState([]);
  const [suggestedUsers, setSuggestedUsers] = useState([]);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await api.get('/social/feed').catch(() => ({ data: { items: [], suggested_users: [] } }));
      setFeed(res?.data?.items || []);
      setSuggestedUsers(res?.data?.suggested_users || []);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const quote = useMemo(() => QUOTES[Math.floor(Math.random() * QUOTES.length)], []);

  const workouts = useMemo(
    () => feed.filter((item) => item.type === 'run' || item.type === 'lift' || item.type === 'workout'),
    [feed]
  );

  const toggleLike = async (activityId) => {
    try {
      const res = await api.post(`/social/like/${activityId}`);
      const liked = Boolean(res?.data?.liked);
      const likesCount = Number(res?.data?.likes_count || 0);
      setFeed((prev) => prev.map((item) => (item.id === activityId ? { ...item, liked, likes_count: likesCount } : item)));
    } catch {}
  };

  const toggleFollow = async (userId, isFollowing) => {
    try {
      if (isFollowing) {
        await api.delete(`/social/unfollow/${userId}`);
      } else {
        await api.post(`/social/follow/${userId}`);
      }
      setSuggestedUsers((prev) => prev.map((u) => u.id === userId ? { ...u, is_following: !isFollowing } : u));
      setFeed((prev) => prev.map((item) => item.user_id === userId ? { ...item, is_following: !isFollowing } : item));
    } catch {}
  };

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={styles.content}
      stickyHeaderIndices={[0]}
      refreshControl={<RefreshControl tintColor="#EAB308" refreshing={refreshing} onRefresh={load} />}
    >
      <Text style={styles.title}>Community</Text>

      <View style={styles.tabRow}>
        {['Feed', 'Workouts', 'Routes'].map((value) => (
          <Pressable key={value} onPress={() => setTab(value)} style={[styles.tab, tab === value && styles.tabActive]}>
            <Text style={[styles.tabText, tab === value && styles.tabTextActive]}>{value}</Text>
          </Pressable>
        ))}
      </View>

      {tab === 'Feed' && (
        <>
          {/* Athletes to Follow */}
          {suggestedUsers.length > 0 && (
            <View style={styles.athletesCard}>
              <Text style={styles.athletesTitle}>Athletes to Follow</Text>
              {suggestedUsers.map((user, index) => (
                <View key={`su-${user.id || index}`} style={styles.athleteRow}>
                  <View style={styles.avatarSmall}>
                    <Text style={styles.avatarText}>{getInitials(user.name)}</Text>
                  </View>
                  <Text style={styles.athleteName}>{user.name || 'Athlete'}</Text>
                  <Pressable
                    style={[styles.followButton, user.is_following && styles.followingButton]}
                    onPress={() => toggleFollow(user.id, Boolean(user.is_following))}
                  >
                    <Text style={[styles.followButtonText, user.is_following && styles.followingButtonText]}>
                      {user.is_following ? 'Following' : 'Follow'}
                    </Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          {feed.map((item, index) => (
            <View key={`feed-${item.id || index}`} style={styles.card}>
              <View style={styles.feedHeader}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{getInitials(item.user_name || item.user?.name)}</Text>
                </View>
                <View style={styles.feedMeta}>
                  <Text style={styles.feedUser}>{item.user_name || item.user?.name || 'Athlete'}</Text>
                  <Text style={styles.feedType}>{item.type || 'activity'}</Text>
                </View>
                {item.user_id && (
                  <Pressable
                    style={[styles.followButton, item.is_following && styles.followingButton]}
                    onPress={() => toggleFollow(item.user_id, Boolean(item.is_following))}
                  >
                    <Text style={[styles.followButtonText, item.is_following && styles.followingButtonText]}>
                      {item.is_following ? 'Following' : 'Follow'}
                    </Text>
                  </Pressable>
                )}
              </View>

              <Text style={styles.feedStats}>
                {item.type === 'run'
                  ? `${Number(item?.data?.distance_miles || 0).toFixed(2)} mi • ${item?.data?.run_type || 'Run'}`
                  : item.type === 'lift'
                    ? `${item?.data?.exercise_name || 'Lift Session'} • ${Number(item?.data?.sets || 0)} sets`
                    : item?.data?.text || 'Activity update'}
              </Text>

              <Text style={styles.feedDate}>{parseDate(item.created_at)?.toLocaleDateString() || '--'}</Text>

              <View style={styles.actionsRow}>
                <Pressable style={styles.actionPill} onPress={() => toggleLike(item.id)}>
                  <Heart size={14} color={item.liked ? '#EAB308' : '#94a3b8'} fill={item.liked ? '#EAB308' : 'none'} />
                  <Text style={styles.actionText}>{Number(item.likes_count || 0)}</Text>
                </Pressable>

                <Pressable style={styles.actionPill}>
                  <MessageCircle size={14} color="#94a3b8" />
                  <Text style={styles.actionText}>{Number(item.comments_count || 0)}</Text>
                </Pressable>
              </View>
            </View>
          ))}

          {!!suggestedUsers.length && (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Suggested Users</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.suggestedRow}>
                {suggestedUsers.map((user, index) => (
                  <View key={`user-${user.id || index}`} style={styles.suggestedCard}>
                    <View style={styles.avatarSmall}>
                      <Text style={styles.avatarText}>{getInitials(user.name)}</Text>
                    </View>
                    <Text style={styles.suggestedName}>{user.name || 'Athlete'}</Text>
                    <Pressable style={styles.followButton}>
                      <Text style={styles.followButtonText}>Follow</Text>
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            </View>
          )}
        </>
      )}

      {tab === 'Workouts' && (
        <>
          {workouts.map((item, index) => (
            <View key={`workout-${item.id || index}`} style={styles.card}>
              <Text style={styles.feedUser}>{item.user_name || 'Athlete'}</Text>
              <Text style={styles.feedStats}>
                {item.type === 'run'
                  ? `${Number(item?.data?.distance_miles || 0).toFixed(2)} mi run`
                  : `${item?.data?.exercise_name || 'Lift'} workout`}
              </Text>
              <Text style={styles.feedDate}>{parseDate(item.created_at)?.toLocaleDateString() || '--'}</Text>
            </View>
          ))}
          {!workouts.length && (
            <View style={styles.card}>
              <Text style={styles.feedDate}>No community workouts yet.</Text>
            </View>
          )}
        </>
      )}

      {tab === 'Routes' && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Routes</Text>
          <Text style={styles.feedDate}>Coming Soon</Text>
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
    marginBottom: 12
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
    fontWeight: '700',
    fontSize: 12
  },
  tabTextActive: {
    color: '#000000'
  },
  quoteCard: {
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accent,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 12,
    marginBottom: 10
  },
  quoteLabel: {
    color: COLORS.accent,
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 4
  },
  quoteText: {
    color: COLORS.text,
    fontSize: 14,
    lineHeight: 20
  },
  card: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 12,
    marginBottom: 10
  },
  feedHeader: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center'
  },
  avatarSmall: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center'
  },
  avatarText: {
    color: COLORS.text,
    fontSize: 11,
    fontWeight: '700'
  },
  feedMeta: {
    marginLeft: 10
  },
  feedUser: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700'
  },
  feedType: {
    color: COLORS.subtext,
    fontSize: 11,
    marginTop: 1
  },
  feedStats: {
    color: COLORS.text,
    marginTop: 8,
    fontSize: 13
  },
  feedDate: {
    color: COLORS.subtext,
    fontSize: 11,
    marginTop: 6
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10
  },
  actionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  actionText: {
    color: COLORS.subtext,
    fontSize: 12,
    fontWeight: '700'
  },
  sectionTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 10
  },
  suggestedRow: {
    gap: 8
  },
  suggestedCard: {
    width: 116,
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 10,
    alignItems: 'center'
  },
  suggestedName: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 6,
    marginBottom: 8
  },
  athletesCard: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12
  },
  athletesTitle: { fontSize: 13, fontWeight: '700', color: COLORS.text, marginBottom: 10 },
  athleteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 10
  },
  athleteName: { flex: 1, color: COLORS.text, fontSize: 13, fontWeight: '600' },
  followButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6
  },
  followButtonText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '700'
  },
  followingButton: {
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  followingButtonText: {
    color: COLORS.text
  }
});
