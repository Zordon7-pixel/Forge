import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Pencil, Trash2 } from 'lucide-react-native';
import Svg, { Line, Polyline, Rect } from 'react-native-svg';

import api from '../lib/api';
import AppHeader from '../components/AppHeader';

// ─── Colors ──────────────────────────────────────────────────────────────────
const C = {
  bg:     '#0d1117',
  card:   '#161b22',
  accent: '#eab308',
  text:   '#ffffff',
  muted:  '#8b949e',
  border: '#21262d',
  green:  '#22c55e',
  red:    '#ef4444',
  input:  '#0d1117',
};

// ─── Pace zones (matches web athleteLanguage.js) ─────────────────────────────
const PACE_ZONES = [
  { zone: 1, label: 'Easy',      color: '#4CAF50' },
  { zone: 2, label: 'Moderate',  color: '#8BC34A' },
  { zone: 3, label: 'Tempo',     color: '#FFC107' },
  { zone: 4, label: 'Threshold', color: '#FF9800' },
  { zone: 5, label: 'Race Pace', color: '#F44336' },
];
function getPaceZone(paceMinPerMile) {
  const p = Number(paceMinPerMile);
  if (!p || p <= 0) return null;
  if (p > 10.5) return PACE_ZONES[0];
  if (p >= 9 && p <= 10.5) return PACE_ZONES[1];
  if (p >= 7.5 && p < 9)   return PACE_ZONES[2];
  if (p >= 6.5 && p < 7.5) return PACE_ZONES[3];
  return PACE_ZONES[4];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function parseDate(item) {
  const raw = item?.date || item?.race_date || item?.created_at || item?.started_at || '';
  if (!raw) return null;
  const candidate = raw.length === 10 ? `${raw}T12:00:00` : raw;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const distanceMiles  = (r) => Number(r?.distance_miles ?? r?.distance ?? 0);
const durationSeconds = (r) => Number(r?.duration_seconds ?? r?.duration ?? 0);

function formatDate(item) {
  const d = parseDate(item);
  return d ? d.toLocaleDateString() : '--';
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds || 0)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatPace(run) {
  const miles = distanceMiles(run);
  const secs  = durationSeconds(run);
  if (!miles || !secs) return '--';
  const pace = secs / 60 / miles;
  const mins = Math.floor(pace);
  const s    = Math.round((pace - mins) * 60);
  return `${mins}:${String(s).padStart(2, '0')}/mi`;
}

function parseMuscleGroups(lift) {
  try {
    if (Array.isArray(lift.muscle_groups)) return lift.muscle_groups;
    return JSON.parse(lift.muscle_groups || '[]');
  } catch {
    return [];
  }
}

// ─── Date filtering ───────────────────────────────────────────────────────────
function withinPeriod(date, period, customFrom, customTo, selectedYear) {
  if (!date) return false;
  if (customFrom || customTo) {
    const d = date.toISOString().slice(0, 10);
    if (customFrom && d < customFrom) return false;
    if (customTo   && d > customTo)   return false;
    return true;
  }
  if (selectedYear) return date.getFullYear() === selectedYear;
  if (period === 'all') return true;
  const days = { week: 7, month: 30, year: 365 }[period];
  return date >= new Date(Date.now() - days * 86400000);
}

// ─── Weekly mileage for bar chart (12 weeks) ─────────────────────────────────
function buildWeeklyMileage(runs) {
  const now   = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - now.getDay());
  start.setHours(0, 0, 0, 0);

  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const wStart = new Date(start); wStart.setDate(start.getDate() - i * 7);
    const wEnd   = new Date(wStart); wEnd.setDate(wStart.getDate() + 6); wEnd.setHours(23, 59, 59, 999);
    const miles  = runs.reduce((sum, r) => {
      const d = parseDate(r);
      return d && d >= wStart && d <= wEnd ? sum + distanceMiles(r) : sum;
    }, 0);
    weeks.push({ label: `${wStart.getMonth() + 1}/${wStart.getDate()}`, miles: Number(miles.toFixed(1)) });
  }
  return weeks;
}

// ─── Pace trend (last 20 runs) ────────────────────────────────────────────────
function buildPaceTrend(filteredRuns) {
  return filteredRuns.slice(0, 20).reverse()
    .map((r, i) => {
      const d = distanceMiles(r);
      const s = durationSeconds(r);
      return { idx: i, pace: d ? Number((s / 60 / d).toFixed(2)) : 0 };
    })
    .filter((x) => x.pace > 0);
}

// ─── SVG bar chart ────────────────────────────────────────────────────────────
function BarChart({ data, width, height = 120 }) {
  const max = Math.max(...data.map((d) => d.miles), 1);
  const bw  = (width - 4) / data.length - 4;

  return (
    <Svg width={width} height={height}>
      {data.map((bar, i) => {
        const h = Math.max(2, (bar.miles / max) * (height - 16));
        const x = i * (bw + 4) + 2;
        return (
          <Rect
            key={i}
            x={x}
            y={height - h}
            width={bw}
            height={h}
            fill={C.accent}
            rx={2}
          />
        );
      })}
    </Svg>
  );
}

// ─── SVG line chart ───────────────────────────────────────────────────────────
function LineChart({ data, width, height = 100 }) {
  if (!data.length) return null;
  const maxP = Math.max(...data.map((d) => d.pace), 1);
  const minP = Math.min(...data.map((d) => d.pace), 0);
  const range = maxP - minP || 1;
  const pad  = 8;

  const points = data.map((d, i) => {
    const x = pad + (i / Math.max(data.length - 1, 1)) * (width - pad * 2);
    const y = pad + ((maxP - d.pace) / range) * (height - pad * 2);
    return `${x},${y}`;
  }).join(' ');

  return (
    <Svg width={width} height={height}>
      <Line x1="0" y1={height} x2={width} y2={height} stroke={C.border} strokeWidth="1" />
      <Polyline points={points} fill="none" stroke={C.accent} strokeWidth="2.5" />
    </Svg>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function History({ navigation }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const chartWidth = width - 56;

  const [refreshing, setRefreshing]     = useState(false);
  const [period, setPeriod]             = useState('all');
  const [tab, setTab]                   = useState('all');
  const [selectedYear, setSelectedYear] = useState(null);
  const [customFrom, setCustomFrom]     = useState('');
  const [customTo, setCustomTo]         = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);

  const [runs,     setRuns]     = useState([]);
  const [lifts,    setLifts]    = useState([]);
  const [workouts, setWorkouts] = useState([]);
  const [races,    setRaces]    = useState([]);

  // ── Load ──
  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [runsRes, liftsRes, workoutsRes, racesRes] = await Promise.all([
        api.get('/runs').catch(() => ({ data: [] })),
        api.get('/lifts').catch(() => ({ data: [] })),
        api.get('/workouts').catch(() => ({ data: [] })),
        api.get('/races').catch(() => ({ data: { races: [] } })),
      ]);
      const sort = (arr) => [...arr].sort((a, b) => (parseDate(b)?.getTime() || 0) - (parseDate(a)?.getTime() || 0));
      setRuns(sort(Array.isArray(runsRes?.data) ? runsRes.data : runsRes?.data?.runs || []));
      setLifts(sort(Array.isArray(liftsRes?.data) ? liftsRes.data : liftsRes?.data?.lifts || []));
      setWorkouts(sort(Array.isArray(workoutsRes?.data) ? workoutsRes.data : workoutsRes?.data?.sessions || []));
      setRaces(sort(racesRes?.data?.races || []));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // ── Filtered sets ──
  const filtered = useCallback(
    (arr) => arr.filter((item) => withinPeriod(parseDate(item), period, customFrom, customTo, selectedYear)),
    [period, customFrom, customTo, selectedYear]
  );

  const filteredRuns     = useMemo(() => filtered(runs),     [filtered, runs]);
  const filteredLifts    = useMemo(() => filtered(lifts),    [filtered, lifts]);
  const filteredWorkouts = useMemo(() => filtered(workouts), [filtered, workouts]);
  const filteredRaces    = useMemo(() => filtered(races),    [filtered, races]);

  // ── Summary stats ──
  const totalMiles = useMemo(
    () => filteredRuns.reduce((s, r) => s + distanceMiles(r), 0),
    [filteredRuns]
  );
  const avgPace = useMemo(() => {
    const valid = filteredRuns.filter((r) => r.distance_miles && r.duration_seconds);
    if (!valid.length) return '--';
    const avg = valid.reduce((s, r) => s + r.duration_seconds / r.distance_miles, 0) / valid.length;
    const mins = Math.floor(avg / 60); const secs = Math.round(avg % 60);
    return `${mins}:${String(secs).padStart(2, '0')}/mi`;
  }, [filteredRuns]);
  const liftCount = useMemo(
    () => filteredLifts.length + filteredWorkouts.length,
    [filteredLifts, filteredWorkouts]
  );
  const currentYear = new Date().getFullYear();

  // ── Charts ──
  const barData       = useMemo(() => buildWeeklyMileage(filteredRuns),   [filteredRuns]);
  const paceTrendData = useMemo(() => buildPaceTrend(filteredRuns),       [filteredRuns]);

  // ── Merged all-tab list ──
  const allItems = useMemo(() => {
    const runItems  = filteredRuns.map((r)  => ({ ...r, _type: 'run',  _date: parseDate(r) }));
    const liftItems = [...filteredLifts, ...filteredWorkouts].map((l) => ({ ...l, _type: 'lift', _date: parseDate(l) }));
    const raceItems = filteredRaces.map((r) => ({ ...r, _type: 'race', _date: parseDate(r) }));
    return [...runItems, ...liftItems, ...raceItems].filter((i) => i._date).sort((a, b) => b._date - a._date);
  }, [filteredRuns, filteredLifts, filteredWorkouts, filteredRaces]);

  // ── Actions ──
  const deleteRun = async (id) => {
    if (!id) return;
    Alert.alert('Delete Run', 'Remove this run from your history?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await api.delete(`/runs/${id}`).catch(() => {});
        setRuns((prev) => prev.filter((r) => r.id !== id));
      }},
    ]);
  };

  const deleteLift = async (id, source) => {
    if (!id) return;
    Alert.alert('Delete Lift', 'Remove this lift from your history?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        if (source === 'workout') {
          await api.delete(`/workouts/${id}`).catch(() => {});
          setWorkouts((prev) => prev.filter((w) => w.id !== id));
        } else {
          await api.delete(`/lifts/${id}`).catch(() => {});
          setLifts((prev) => prev.filter((l) => l.id !== id));
        }
      }},
    ]);
  };

  const missedWorkout = () => Alert.alert(
    'Missed Workout',
    'Let your coach know and your plan will be adjusted for next week.',
    [{ text: 'OK' }]
  );

  // ─── Render helpers ───────────────────────────────────────────────────────
  const renderRunCard = (run, index) => {
    const pz = run.distance_miles && run.duration_seconds
      ? getPaceZone(run.duration_seconds / 60 / run.distance_miles)
      : null;
    return (
      <View key={`run-${run.id || index}`} style={styles.itemCard}>
        <View style={styles.rowBetween}>
          <View style={styles.itemLeft}>
            <View style={styles.rowInline}>
              <View style={[styles.badge, { backgroundColor: C.accent }]}>
                <Text style={[styles.badgeText, { color: '#000' }]}>Run</Text>
              </View>
              {pz ? (
                <View style={[styles.badge, { backgroundColor: `${pz.color}22` }]}>
                  <Text style={[styles.badgeText, { color: pz.color }]}>Zone {pz.zone}</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.itemTitle}>{distanceMiles(run).toFixed(2)} mi</Text>
            <Text style={styles.itemSub}>
              {formatPace(run)} · {formatDuration(durationSeconds(run))}
              {(run.calories_burned || run.calories) > 0
                ? ` · ${run.calories_burned || run.calories} cal`
                : ''}
            </Text>
            {run.notes ? (
              <Text style={[styles.itemSub, { fontStyle: 'italic', marginTop: 4 }]}>
                "{run.notes}"
              </Text>
            ) : null}
          </View>
          <Text style={styles.itemSub}>{formatDate(run)}</Text>
        </View>
        <View style={styles.actionRow}>
          <Pressable onPress={() => Alert.alert('Edit', 'Edit run — coming soon.')} style={styles.actionBtn}>
            <Pencil size={14} color={C.muted} />
          </Pressable>
          <Pressable onPress={() => deleteRun(run.id)} style={styles.actionBtn}>
            <Trash2 size={14} color={C.red} />
          </Pressable>
        </View>
      </View>
    );
  };

  const renderLiftCard = (lift, index) => {
    const tags = parseMuscleGroups(lift);
    const source = lift.started_at ? 'workout' : 'lift';
    return (
      <View key={`lift-${lift.id || index}`} style={styles.itemCard}>
        <View style={styles.rowBetween}>
          <View style={styles.itemLeft}>
            <View style={[styles.badge, { backgroundColor: C.border, alignSelf: 'flex-start', marginBottom: 6 }]}>
              <Text style={[styles.badgeText, { color: C.muted }]}>Lift</Text>
            </View>
            <Text style={styles.itemTitle}>
              {lift.exercise_name || lift.name || 'Lift Session'}
            </Text>
            <Text style={styles.itemSub}>
              {lift.started_at
                ? `Duration: ${lift.total_seconds ? formatDuration(lift.total_seconds) : '--'}`
                : `${lift.sets || 0} × ${lift.reps || 0} @ ${lift.weight_lbs || lift.weight || 0} lbs`}
              {(lift.calories_burned) > 0 ? ` · ${lift.calories_burned} cal` : ''}
            </Text>
            {tags.length > 0 ? (
              <View style={styles.tagRow}>
                {tags.map((tag) => (
                  <View key={tag} style={styles.tag}>
                    <Text style={styles.tagText}>{tag}</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
          <Text style={styles.itemSub}>{formatDate(lift)}</Text>
        </View>
        <View style={styles.actionRow}>
          <Pressable onPress={() => Alert.alert('Edit', 'Edit lift — coming soon.')} style={styles.actionBtn}>
            <Pencil size={14} color={C.muted} />
          </Pressable>
          <Pressable onPress={() => deleteLift(lift.id, source)} style={styles.actionBtn}>
            <Trash2 size={14} color={C.red} />
          </Pressable>
        </View>
      </View>
    );
  };

  const renderRaceCard = (race, index) => {
    const d = parseDate(race);
    const upcoming = d ? d >= new Date() : false;
    return (
      <View key={`race-${race.id || index}`} style={styles.itemCard}>
        <View style={styles.rowBetween}>
          <View>
            <Text style={styles.itemTitle}>{race.race_name || race.name || 'Race'}</Text>
            <Text style={styles.itemSub}>
              {race.distance_miles ? `${race.distance_miles} mi · ` : ''}
              {formatDate(race)}
              {race.location ? ` · ${race.location}` : ''}
            </Text>
          </View>
          <View style={[styles.badge, {
            backgroundColor: upcoming ? 'rgba(234,179,8,0.15)' : 'rgba(34,197,94,0.15)',
          }]}>
            <Text style={[styles.badgeText, { color: upcoming ? C.accent : C.green }]}>
              {upcoming ? 'Upcoming' : 'Done'}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl tintColor={C.accent} refreshing={refreshing} onRefresh={load} />}
    >
      <AppHeader />

      {/* ── Summary stats ── */}
      <View style={styles.statsRow}>
        {[
          ['Distance', `${totalMiles.toFixed(1)} mi`],
          ['Avg Pace',  avgPace],
          ['Lifts',     String(liftCount)],
        ].map(([label, value]) => (
          <View key={label} style={styles.statBox}>
            <Text style={styles.statMuted}>{label}</Text>
            <Text style={styles.statValue}>{value}</Text>
          </View>
        ))}
      </View>

      {/* ── Period filter bar ── */}
      <View style={styles.periodBar}>
        {['week', 'month', 'year', 'all'].map((p) => (
          <Pressable
            key={p}
            onPress={() => { setPeriod(p); setSelectedYear(null); setCustomFrom(''); setCustomTo(''); }}
            style={[styles.periodBtn, period === p && !selectedYear && !customFrom && !customTo && styles.periodBtnActive]}
          >
            <Text style={[styles.periodText, period === p && !selectedYear && !customFrom && !customTo && styles.periodTextActive]}>
              {p === 'week' ? 'W' : p === 'month' ? 'M' : p === 'year' ? 'Y' : 'All'}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* ── Year/Custom filter row ── */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.yearScroll} contentContainerStyle={styles.yearRow}>
        <Pressable
          onPress={() => { setSelectedYear(selectedYear === currentYear ? null : currentYear); setCustomFrom(''); setCustomTo(''); }}
          style={[styles.yearBtn, selectedYear === currentYear && styles.yearBtnActive]}
        >
          <Text style={[styles.yearText, selectedYear === currentYear && styles.yearTextActive]}>{currentYear}</Text>
        </Pressable>
        <Pressable
          onPress={() => { setShowDatePicker((p) => !p); setSelectedYear(null); }}
          style={[styles.yearBtn, (customFrom || customTo) && styles.yearBtnActive]}
        >
          <Text style={[styles.yearText, (customFrom || customTo) && styles.yearTextActive]}>Custom Range</Text>
        </Pressable>
      </ScrollView>

      {/* ── Custom date inputs ── */}
      {showDatePicker ? (
        <View style={styles.datePicker}>
          <Text style={styles.datePickerLabel}>Custom Date Range</Text>
          <View style={styles.dateInputRow}>
            <View style={styles.dateInputWrap}>
              <Text style={styles.dateInputLabel}>From (YYYY-MM-DD)</Text>
              <TextInput
                style={styles.dateInput}
                placeholder="2025-01-01"
                placeholderTextColor={C.muted}
                value={customFrom}
                onChangeText={setCustomFrom}
                keyboardType="numbers-and-punctuation"
                maxLength={10}
              />
            </View>
            <View style={styles.dateInputWrap}>
              <Text style={styles.dateInputLabel}>To (YYYY-MM-DD)</Text>
              <TextInput
                style={styles.dateInput}
                placeholder="2025-12-31"
                placeholderTextColor={C.muted}
                value={customTo}
                onChangeText={setCustomTo}
                keyboardType="numbers-and-punctuation"
                maxLength={10}
              />
            </View>
          </View>
          {(customFrom || customTo) ? (
            <Pressable onPress={() => { setCustomFrom(''); setCustomTo(''); setShowDatePicker(false); }}>
              <Text style={styles.clearText}>Clear</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* ── Bar chart — weekly mileage ── */}
      <View style={styles.chartCard}>
        <Text style={styles.chartTitle}>Weekly Mileage (12 Weeks)</Text>
        <View style={styles.chartSpacing}>
          <BarChart data={barData} width={chartWidth} height={110} />
        </View>
      </View>

      {/* ── Line chart — pace trend ── */}
      {paceTrendData.length > 1 ? (
        <View style={styles.chartCard}>
          <Text style={styles.chartTitle}>Pace Trend (last {paceTrendData.length} runs)</Text>
          <View style={styles.chartSpacing}>
            <LineChart data={paceTrendData} width={chartWidth} height={90} />
          </View>
        </View>
      ) : null}

      {/* ── Type tab bar ── */}
      <View style={styles.tabBar}>
        {[['all', 'All'], ['runs', 'Runs'], ['lifts', 'Lifts'], ['races', 'Races']].map(([v, label]) => (
          <Pressable
            key={v}
            onPress={() => setTab(v)}
            style={[styles.tabBtn, tab === v && styles.tabBtnActive]}
          >
            <Text style={[styles.tabText, tab === v && styles.tabTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {/* ── Content by tab ── */}
      {tab === 'all' && allItems.map((item, i) => {
        if (item._type === 'run')  return renderRunCard(item, i);
        if (item._type === 'lift') return renderLiftCard(item, i);
        return renderRaceCard(item, i);
      })}

      {tab === 'runs' && (
        <>
          {filteredRuns.map((r, i) => renderRunCard(r, i))}
          {filteredRuns.length === 0 ? <EmptyState message="No runs for this period." sub="Lace up and log your next run." /> : null}
          <Pressable onPress={missedWorkout} style={styles.missedBtn}>
            <Text style={styles.missedText}>Missed a workout? Let me know — I'll adjust your plan</Text>
          </Pressable>
        </>
      )}

      {tab === 'lifts' && (
        <>
          {[...filteredLifts, ...filteredWorkouts].map((l, i) => renderLiftCard(l, i))}
          {filteredLifts.length === 0 && filteredWorkouts.length === 0
            ? <EmptyState message="No lifts for this period." sub="Hit the weights." />
            : null}
        </>
      )}

      {tab === 'races' && (
        <>
          {filteredRaces.map((r, i) => renderRaceCard(r, i))}
          {filteredRaces.length === 0 ? <EmptyState message="No races logged." sub="Add a race to track your goals." /> : null}
        </>
      )}
    </ScrollView>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ message, sub }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyTitle}>{message}</Text>
      {sub ? <Text style={styles.emptySub}>{sub}</Text> : null}
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content:   { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32 },

  // Summary stats
  statsRow:  { flexDirection: 'row', gap: 8, marginBottom: 12 },
  statBox:   { flex: 1, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 10, alignItems: 'center' },
  statMuted: { color: C.muted, fontSize: 11, marginBottom: 2 },
  statValue: { color: C.text,  fontSize: 13, fontWeight: '700' },

  // Period filter
  periodBar:        { flexDirection: 'row', borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: C.border, marginBottom: 10 },
  periodBtn:        { flex: 1, paddingVertical: 8, alignItems: 'center', backgroundColor: C.input },
  periodBtnActive:  { backgroundColor: C.accent },
  periodText:       { color: C.muted, fontSize: 12, fontWeight: '700' },
  periodTextActive: { color: '#000' },

  // Year filter
  yearScroll: { marginBottom: 10 },
  yearRow:    { flexDirection: 'row', gap: 8, paddingBottom: 2 },
  yearBtn:    { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, borderWidth: 1.5, borderColor: C.border, backgroundColor: C.input },
  yearBtnActive:  { backgroundColor: C.accent, borderColor: C.accent },
  yearText:       { color: C.muted, fontSize: 13, fontWeight: '700' },
  yearTextActive: { color: '#000' },

  // Date picker
  datePicker:      { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 14, marginBottom: 12 },
  datePickerLabel: { color: C.muted, fontSize: 12, fontWeight: '700', marginBottom: 10 },
  dateInputRow:    { flexDirection: 'row', gap: 10 },
  dateInputWrap:   { flex: 1 },
  dateInputLabel:  { color: C.muted, fontSize: 11, marginBottom: 4 },
  dateInput:       { backgroundColor: C.input, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 8, color: C.text, fontSize: 13 },
  clearText:       { color: C.muted, fontSize: 12, marginTop: 8 },

  // Charts
  chartCard:    { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 14, marginBottom: 12 },
  chartTitle:   { color: C.text, fontSize: 13, fontWeight: '700' },
  chartSpacing: { marginTop: 10 },

  // Tab bar
  tabBar:       { flexDirection: 'row', borderBottomWidth: 1, borderColor: C.border, marginBottom: 12 },
  tabBtn:       { flex: 1, paddingVertical: 10, alignItems: 'center', borderBottomWidth: 2, borderColor: 'transparent' },
  tabBtnActive: { borderColor: C.accent },
  tabText:      { color: C.muted, fontSize: 13, fontWeight: '600' },
  tabTextActive:{ color: C.text },

  // Item cards
  itemCard:  { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 12, marginBottom: 8 },
  rowBetween:{ flexDirection: 'row', justifyContent: 'space-between' },
  rowInline: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  itemLeft:  { flex: 1, paddingRight: 8 },
  badge:     { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  badgeText: { fontSize: 10, fontWeight: '700' },
  itemTitle: { color: C.text, fontSize: 14, fontWeight: '700' },
  itemSub:   { color: C.muted, fontSize: 12, marginTop: 2 },

  // Muscle group tags
  tagRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  tag:     { backgroundColor: C.input, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  tagText: { color: C.muted, fontSize: 11 },

  // Actions
  actionRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 10 },
  actionBtn: { borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 6 },

  // Missed workout
  missedBtn:  { backgroundColor: C.input, borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginTop: 8, marginBottom: 12 },
  missedText: { color: C.muted, fontSize: 13 },

  // Empty state
  emptyState: { alignItems: 'center', paddingVertical: 40 },
  emptyTitle: { color: C.text,  fontSize: 15, fontWeight: '600', marginBottom: 6 },
  emptySub:   { color: C.muted, fontSize: 13 },
});
