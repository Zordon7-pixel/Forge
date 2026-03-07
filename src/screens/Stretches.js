import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Move, Sparkles } from 'lucide-react-native';

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

export default function Stretches({ navigation }) {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stretches, setStretches] = useState([]);
  const [error, setError] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const response = await api.get('/stretches');
      const items = Array.isArray(response?.data)
        ? response.data
        : response?.data?.stretches || [];
      setStretches(items);
    } catch (loadError) {
      setError(loadError?.response?.data?.message || 'Could not load stretches.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const byCategory = useMemo(() => {
    return stretches.reduce((acc, item) => {
      const key = item?.category || 'General';
      if (!acc[key]) acc[key] = [];
      acc[key].push(item);
      return acc;
    }, {});
  }, [stretches]);

  const startSession = (items) => {
    navigation.navigate('StretchSession', { stretches: items });
  };

  const onRefresh = () => {
    setRefreshing(true);
    load(true);
  };

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl tintColor={COLORS.accent} refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <AppHeader />

      <View style={styles.heroCard}>
        <Text style={styles.title}>Stretches</Text>
        <Text style={styles.subtitle}>Browse mobility work and start a guided 30s-per-stretch session.</Text>

        {!!stretches.length && (
          <Pressable style={styles.aiButton} onPress={() => startSession(stretches)}>
            <Sparkles color="#000" size={14} />
            <Text style={styles.aiButtonText}>Start Full Routine</Text>
          </Pressable>
        )}
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={COLORS.accent} />
          <Text style={styles.loadingText}>Loading stretches...</Text>
        </View>
      ) : null}

      {!loading && !!error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryButton} onPress={() => load()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {!loading && !error && !stretches.length ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>No stretches available yet.</Text>
        </View>
      ) : null}

      {!loading && !error && Object.entries(byCategory).map(([category, items]) => (
        <View key={category} style={styles.card}>
          <View style={styles.categoryRow}>
            <View>
              <Text style={styles.categoryTitle}>{category}</Text>
              <Text style={styles.categorySubtitle}>{items.length} stretches</Text>
            </View>
            <Pressable style={styles.smallButton} onPress={() => startSession(items)}>
              <Text style={styles.smallButtonText}>Start</Text>
            </Pressable>
          </View>

          <View style={styles.listWrap}>
            {items.map((stretch, idx) => (
              <Pressable key={stretch.id || `${category}-${idx}`} onPress={() => startSession([stretch])} style={styles.listRow}>
                <Move color={COLORS.accent} size={14} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.stretchName}>{stretch.name || 'Stretch'}</Text>
                  <Text style={styles.stretchCue} numberOfLines={2}>{stretch.cue || stretch.description || 'Tap to start a guided 30s hold.'}</Text>
                </View>
                <Text style={styles.stretchDuration}>30s</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
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
    paddingBottom: 28,
  },
  heroCard: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  title: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '900',
  },
  subtitle: {
    color: COLORS.subtext,
    marginTop: 4,
    fontSize: 13,
  },
  aiButton: {
    marginTop: 14,
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  aiButtonText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '800',
  },
  loadingWrap: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 18,
    alignItems: 'center',
    gap: 10,
  },
  loadingText: {
    color: COLORS.subtext,
    fontSize: 13,
  },
  errorCard: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: '#7f1d1d',
    borderRadius: 14,
    padding: 14,
    gap: 12,
  },
  errorText: {
    color: '#fca5a5',
    fontSize: 13,
  },
  retryButton: {
    borderRadius: 10,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  retryText: {
    color: COLORS.subtext,
    fontWeight: '700',
    fontSize: 13,
  },
  card: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
  },
  emptyText: {
    color: COLORS.subtext,
    fontSize: 14,
  },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  categoryTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '800',
  },
  categorySubtitle: {
    color: COLORS.subtext,
    fontSize: 12,
    marginTop: 2,
  },
  smallButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: COLORS.accent,
    borderRadius: 999,
  },
  smallButtonText: {
    color: '#000',
    fontWeight: '800',
    fontSize: 12,
  },
  listWrap: {
    marginTop: 10,
    gap: 8,
  },
  listRow: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: '#111623',
    borderRadius: 12,
    padding: 10,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  stretchName: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700',
  },
  stretchCue: {
    color: COLORS.subtext,
    fontSize: 12,
    marginTop: 2,
  },
  stretchDuration: {
    color: COLORS.accent,
    fontSize: 12,
    fontWeight: '700',
  },
});
