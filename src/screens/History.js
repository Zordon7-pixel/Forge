import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Pencil, Trash2 } from 'lucide-react-native';
import Svg, { Line, Polyline, Rect } from 'react-native-svg';

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

const parseDate = (item) => {
  const raw = item?.date || item?.race_date || item?.created_at || item?.started_at || '';
  if (!raw) return null;
  const candidate = raw.length === 10 ? `${raw}T12:00:00` : raw;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const distanceMiles = (run) => Number(run?.distance_miles ?? run?.distance ?? 0);
const durationSeconds = (run) => Number(run?.duration_seconds ?? run?.duration ?? 0);
const runCalories = (run) => Number(run?.calories_burned ?? run?.calories ?? 0);

const formatDate = (item) => {
  const date = parseDate(item);
  return date ? date.toLocaleDateString() : '--';
};

const formatDuration = (seconds) => {
  const safe = Math.max(0, Math.round(Number(seconds || 0)));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const formatPace = (run) => {
  const miles = distanceMiles(run);
  const seconds = durationSeconds(run);
  if (!miles || !seconds) return '--';
  const pace = seconds / 60 / miles;
  const mins = Math.floor(pace);
  const secs = Math.round((pace - mins) * 60);
  return `${mins}:${String(secs).padStart(2, '0')}/mi`;
};

const withinPeriod = (date, period) => {
  if (!date) return false;
  const now = new Date();
  if (period === 'All') return true;
  if (period === 'Year') return date.getFullYear() === now.getFullYear();
  const since = new Date();
  since.setDate(now.getDate() - 90);
  return date >= since;
};

const weeklyMileage = (runs) => {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - now.getDay());
  start.setHours(0, 0, 0, 0);

  const weeks = [];
  for (let i = 11; i >= 0; i -= 1) {
    const weekStart = new Date(start);
    weekStart.setDate(start.getDate() - i * 7);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const miles = runs.reduce((sum, run) => {
      const runDate = parseDate(run);
      if (!runDate) return sum;
      return runDate >= weekStart && runDate <= weekEnd ? sum + distanceMiles(run) : sum;
    }, 0);

    weeks.push({
      start: weekStart,
      miles: Number(miles.toFixed(1))
    });
  }
  return weeks;
};

export default function History() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState('All');
  const [tab, setTab] = useState('All');
  const [runs, setRuns] = useState([]);
  const [lifts, setLifts] = useState([]);
  const [workouts, setWorkouts] = useState([]);
  const [races, setRaces] = useState([]);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [runsRes, liftsRes, workoutsRes, racesRes] = await Promise.all([
        api.get('/runs').catch(() => ({ data: [] })),
        api.get('/lifts').catch(() => ({ data: [] })),
        api.get('/workouts').catch(() => ({ data: [] })),
        api.get('/races').catch(() => ({ data: { races: [] } }))
      ]);

      const runsData = Array.isArray(runsRes?.data) ? runsRes.data : runsRes?.data?.runs || [];
      const liftsData = Array.isArray(liftsRes?.data) ? liftsRes.data : liftsRes?.data?.lifts || [];
      const workoutsData = Array.isArray(workoutsRes?.data)
        ? workoutsRes.data
        : workoutsRes?.data?.sessions || workoutsRes?.data?.workouts || [];
      const racesData = racesRes?.data?.races || [];

      setRuns(runsData.sort((a, b) => (parseDate(b)?.getTime() || 0) - (parseDate(a)?.getTime() || 0)));
      setLifts(liftsData.sort((a, b) => (parseDate(b)?.getTime() || 0) - (parseDate(a)?.getTime() || 0)));
      setWorkouts(workoutsData.sort((a, b) => (parseDate(b)?.getTime() || 0) - (parseDate(a)?.getTime() || 0)));
      setRaces(racesData.sort((a, b) => (parseDate(b)?.getTime() || 0) - (parseDate(a)?.getTime() || 0)));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const filteredRuns = useMemo(
    () => runs.filter((run) => withinPeriod(parseDate(run), period)),
    [period, runs]
  );

  const filteredLifts = useMemo(
    () => lifts.filter((lift) => withinPeriod(parseDate(lift), period)),
    [lifts, period]
  );

  const filteredWorkouts = useMemo(
    () => workouts.filter((workout) => withinPeriod(parseDate(workout), period)),
    [period, workouts]
  );

  const filteredRaces = useMemo(
    () => races.filter((race) => withinPeriod(parseDate(race), period)),
    [period, races]
  );

  const totalMiles = useMemo(
    () => filteredRuns.reduce((sum, run) => sum + distanceMiles(run), 0),
    [filteredRuns]
  );

  const runsThisYear = useMemo(() => {
    const year = new Date().getFullYear();
    return runs.filter((run) => parseDate(run)?.getFullYear() === year).length;
  }, [runs]);

  const barData = useMemo(() => weeklyMileage(filteredRuns), [filteredRuns]);

  const chart = useMemo(() => {
    const chartWidth = Math.max(width - 56, 240);
    const chartHeight = 150;
    const maxMiles = Math.max(...barData.map((x) => x.miles), 1);

    const barWidth = chartWidth / barData.length - 4;
    const bars = barData.map((point, index) => {
      const h = (point.miles / maxMiles) * (chartHeight - 20);
      const x = index * (barWidth + 4) + 2;
      const y = chartHeight - h;
      return { ...point, x, y, h, w: barWidth };
    });

    let rolling = 0;
    const linePoints = bars
      .map((bar) => {
        rolling += bar.miles;
        return {
          x: bar.x + bar.w / 2,
          y: chartHeight - (rolling / Math.max(bars.reduce((s, b) => s + b.miles, 0), 1)) * (chartHeight - 20)
        };
      })
      .map((point) => `${point.x},${point.y}`)
      .join(' ');

    return { chartWidth, chartHeight, bars, linePoints };
  }, [barData, width]);

  const allItems = useMemo(() => {
    const runItems = filteredRuns.map((run) => ({ ...run, _type: 'run', _date: parseDate(run) }));
    const liftItems = [...filteredLifts, ...filteredWorkouts].map((lift) => ({
      ...lift,
      _type: 'lift',
      _date: parseDate(lift)
    }));
    const raceItems = filteredRaces.map((race) => ({ ...race, _type: 'race', _date: parseDate(race) }));

    return [...runItems, ...liftItems, ...raceItems]
      .filter((item) => item._date)
      .sort((a, b) => b._date - a._date);
  }, [filteredLifts, filteredRaces, filteredRuns, filteredWorkouts]);

  const onDeleteRun = async (id) => {
    if (!id) return;
    try {
      await api.delete(`/runs/${id}`);
      setRuns((prev) => prev.filter((run) => run.id !== id));
    } catch {
      Alert.alert('Delete Failed', 'Could not delete run.');
    }
  };

  const onDeleteLift = async (id, source) => {
    if (!id) return;
    try {
      if (source === 'workout') {
        await api.delete(`/workouts/${id}`);
        setWorkouts((prev) => prev.filter((item) => item.id !== id));
      } else {
        await api.delete(`/lifts/${id}`);
        setLifts((prev) => prev.filter((item) => item.id !== id));
      }
    } catch {
      Alert.alert('Delete Failed', 'Could not delete lift.');
    }
  };

  const editPlaceholder = () => Alert.alert('Edit', 'Edit UI coming soon.');

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={styles.content}
      stickyHeaderIndices={[0]}
      refreshControl={<RefreshControl tintColor="#EAB308" refreshing={refreshing} onRefresh={load} />}
    >
      <View style={styles.headerCard}>
        <Text style={styles.totalMiles}>{totalMiles.toFixed(1)}</Text>
        <Text style={styles.totalMilesLabel}>Total miles</Text>
        <View style={styles.headerRow}>
          <Text style={styles.headerMeta}>Total runs: {filteredRuns.length}</Text>
          <Text style={styles.headerMeta}>This year: {runsThisYear}</Text>
        </View>

        <View style={styles.pillRow}>
          {['All', 'Year', 'Custom'].map((value) => (
            <Pressable
              key={value}
              onPress={() => setPeriod(value)}
              style={[styles.pill, period === value && styles.pillActive]}
            >
              <Text style={[styles.pillText, period === value && styles.pillTextActive]}>{value}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.chartCard}>
        <Text style={styles.chartTitle}>Weekly Mileage (12 Weeks)</Text>
        <Svg width={chart.chartWidth} height={chart.chartHeight} style={styles.chartSpacing}>
          {chart.bars.map((bar) => (
            <Rect
              key={bar.start.toISOString()}
              x={bar.x}
              y={bar.y}
              width={bar.w}
              height={Math.max(2, bar.h)}
              fill="#EAB308"
              rx={2}
            />
          ))}
        </Svg>
      </View>

      <View style={styles.chartCard}>
        <Text style={styles.chartTitle}>Cumulative Line</Text>
        <Svg width={chart.chartWidth} height={chart.chartHeight} style={styles.chartSpacing}>
          <Line x1="0" y1={chart.chartHeight} x2={chart.chartWidth} y2={chart.chartHeight} stroke="#2c3345" strokeWidth="1" />
          <Polyline points={chart.linePoints} fill="none" stroke="#EAB308" strokeWidth="3" />
        </Svg>
      </View>

      <View style={styles.pillRow}>
        {['All', 'Runs', 'Lifts', 'Races'].map((value) => (
          <Pressable
            key={value}
            onPress={() => setTab(value)}
            style={[styles.pill, tab === value && styles.pillActive]}
          >
            <Text style={[styles.pillText, tab === value && styles.pillTextActive]}>{value}</Text>
          </Pressable>
        ))}
      </View>

      {(tab === 'All' ? allItems : []).map((item, index) => (
        <View key={`${item._type}-${item.id || index}`} style={styles.itemCard}>
          <Text style={styles.itemTitle}>
            {item._type === 'run' ? `${distanceMiles(item).toFixed(2)} mi run` : item._type === 'lift' ? (item.name || item.exercise_name || 'Lift') : (item.name || 'Race')}
          </Text>
          <Text style={styles.itemSub}>{formatDate(item)}</Text>
        </View>
      ))}

      {(tab === 'Runs' ? filteredRuns : []).map((run, index) => (
        <View key={`run-${run.id || index}`} style={styles.itemCard}>
          <View style={styles.rowBetween}>
            <View style={styles.itemLeft}>
              <View style={[styles.badge, styles.runBadge]}>
                <Text style={[styles.badgeText, styles.runBadgeText]}>Run</Text>
              </View>
              <Text style={styles.itemTitle}>{distanceMiles(run).toFixed(2)} mi</Text>
              <Text style={styles.itemSub}>
                {formatPace(run)} - {formatDuration(durationSeconds(run))} - {Math.round(runCalories(run))} cal
              </Text>
            </View>
            <Text style={styles.itemSub}>{formatDate(run)}</Text>
          </View>

          <View style={styles.actionRow}>
            <Pressable onPress={editPlaceholder} style={styles.actionButton}>
              <Pencil size={14} color="#94a3b8" />
            </Pressable>
            <Pressable onPress={() => onDeleteRun(run.id)} style={styles.actionButton}>
              <Trash2 size={14} color="#ef4444" />
            </Pressable>
          </View>
        </View>
      ))}

      {(tab === 'Lifts' ? [...filteredLifts, ...filteredWorkouts] : []).map((lift, index) => (
        <View key={`lift-${lift.id || index}`} style={styles.itemCard}>
          <View style={styles.rowBetween}>
            <View style={styles.itemLeft}>
              <View style={[styles.badge, styles.liftBadge]}>
                <Text style={[styles.badgeText, styles.liftBadgeText]}>Lift</Text>
              </View>
              <Text style={styles.itemTitle}>{lift.name || lift.exercise_name || 'Lift Session'}</Text>
              <Text style={styles.itemSub}>
                {Array.isArray(lift.sets) ? lift.sets.length : Number(lift.set_count || 0)} x
                {' '}{Array.isArray(lift.sets)
                  ? lift.sets.reduce((sum, set) => sum + Number(set.reps || 0), 0)
                  : Number(lift.total_reps || 0)} x
                {' '}{Number(lift.weight || 0)}
              </Text>
            </View>
            <Text style={styles.itemSub}>{formatDate(lift)}</Text>
          </View>

          <View style={styles.actionRow}>
            <Pressable onPress={editPlaceholder} style={styles.actionButton}>
              <Pencil size={14} color="#94a3b8" />
            </Pressable>
            <Pressable onPress={() => onDeleteLift(lift.id, lift.started_at ? 'workout' : 'lift')} style={styles.actionButton}>
              <Trash2 size={14} color="#ef4444" />
            </Pressable>
          </View>
        </View>
      ))}

      {(tab === 'Races' ? filteredRaces : []).map((race, index) => {
        const raceDate = parseDate(race);
        const isUpcoming = raceDate ? raceDate >= new Date() : false;
        return (
          <View key={`race-${race.id || index}`} style={styles.itemCard}>
            <View style={styles.rowBetween}>
              <View>
                <Text style={styles.itemTitle}>{race.name || 'Race'}</Text>
                <Text style={styles.itemSub}>{race.type || 'Race'} - {formatDate(race)}</Text>
              </View>
              <View style={[styles.badge, isUpcoming ? styles.runBadge : styles.liftBadge]}>
                <Text style={[styles.badgeText, isUpcoming ? styles.runBadgeText : styles.liftBadgeText]}>
                  {isUpcoming ? 'Upcoming' : 'Done'}
                </Text>
              </View>
            </View>
          </View>
        );
      })}

      {((tab === 'All' && !allItems.length) ||
        (tab === 'Runs' && !filteredRuns.length) ||
        (tab === 'Lifts' && !filteredLifts.length && !filteredWorkouts.length) ||
        (tab === 'Races' && !filteredRaces.length)) && (
        <View style={styles.itemCard}>
          <Text style={styles.itemSub}>No history yet.</Text>
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
  headerCard: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    padding: 14,
    marginBottom: 12
  },
  totalMiles: {
    color: COLORS.text,
    fontSize: 32,
    fontWeight: '800'
  },
  totalMilesLabel: {
    color: COLORS.subtext,
    fontSize: 12,
    marginBottom: 8
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between'
  },
  headerMeta: {
    color: COLORS.subtext,
    fontSize: 12
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
    marginTop: 10
  },
  pill: {
    backgroundColor: COLORS.input,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7
  },
  pillActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent
  },
  pillText: {
    color: COLORS.subtext,
    fontWeight: '700',
    fontSize: 12
  },
  pillTextActive: {
    color: '#000000'
  },
  chartCard: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    marginBottom: 12
  },
  chartTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '700'
  },
  chartSpacing: {
    marginTop: 10
  },
  itemCard: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between'
  },
  itemLeft: {
    flex: 1,
    paddingRight: 8
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
    alignSelf: 'flex-start',
    marginBottom: 6
  },
  runBadge: {
    backgroundColor: COLORS.accent
  },
  liftBadge: {
    backgroundColor: COLORS.border
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700'
  },
  runBadgeText: {
    color: '#000000'
  },
  liftBadgeText: {
    color: COLORS.subtext
  },
  itemTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700'
  },
  itemSub: {
    color: COLORS.subtext,
    fontSize: 12,
    marginTop: 3
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 10
  },
  actionButton: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    padding: 6
  }
});
