import React, { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Svg, { Defs, LinearGradient, Polygon, Polyline, Stop } from 'react-native-svg';

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

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const getDateValue = (item) => item?.date || item?.race_date || item?.created_at || item?.started_at || '';
const parseDate = (item) => {
  const raw = getDateValue(item);
  if (!raw) return null;
  const candidate = raw.length === 10 ? `${raw}T12:00:00` : raw;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const getDistanceMiles = (run) => Number(run?.distance_miles ?? run?.distance ?? 0);
const getDurationSeconds = (run) => Number(run?.duration_seconds ?? run?.duration ?? 0);
const getCalories = (run) => Number(run?.calories_burned ?? run?.calories ?? 0);

const formatPace = (seconds, miles) => {
  if (!seconds || !miles) return '--';
  const pace = seconds / 60 / miles;
  const mins = Math.floor(pace);
  const secs = Math.round((pace - mins) * 60);
  return `${mins}:${String(secs).padStart(2, '0')}/mi`;
};

const formatDuration = (totalSeconds = 0) => {
  const safe = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
};

const formatShortDate = (dateValue) => {
  if (!dateValue) return '--';
  const date = parseDate({ date: dateValue });
  return date ? date.toLocaleDateString() : '--';
};

const startOfWeek = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
};

const isSameDay = (a, b) => (
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()
);

const getWeeksMileage = (runs) => {
  const now = new Date();
  const currentWeekStart = startOfWeek(now);
  const out = [];

  for (let i = 11; i >= 0; i -= 1) {
    const weekStart = new Date(currentWeekStart);
    weekStart.setDate(currentWeekStart.getDate() - i * 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const miles = runs.reduce((sum, run) => {
      const date = parseDate(run);
      if (!date) return sum;
      if (date >= weekStart && date <= weekEnd) {
        return sum + getDistanceMiles(run);
      }
      return sum;
    }, 0);

    out.push({
      start: weekStart,
      label: weekStart.toLocaleDateString('en-US', { month: 'short' }),
      miles: Number(miles.toFixed(1))
    });
  }

  return out;
};

export default function Dashboard({ navigation }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [refreshing, setRefreshing] = useState(false);
  const [runs, setRuns] = useState([]);
  const [lifts, setLifts] = useState([]);
  const [races, setRaces] = useState([]);
  const [user, setUser] = useState(null);
  const [stats, setStats] = useState(null);
  const [readiness, setReadiness] = useState('--');

  const loadDashboard = useCallback(async () => {
    setRefreshing(true);
    try {
      const [runsRes, liftsRes, racesRes, meRes, statsRes, readinessRes] = await Promise.all([
        api.get('/runs').catch(() => ({ data: [] })),
        api.get('/lifts').catch(() => ({ data: [] })),
        api.get('/races').catch(() => ({ data: { races: [] } })),
        api.get('/auth/me').catch(() => ({ data: {} })),
        api.get('/auth/me/stats').catch(() => ({ data: {} })),
        api.get('/checkin/streak').catch(() => ({ data: null }))
      ]);

      const runsData = Array.isArray(runsRes?.data) ? runsRes.data : runsRes?.data?.runs || [];
      const liftsData = Array.isArray(liftsRes?.data)
        ? liftsRes.data
        : liftsRes?.data?.lifts || liftsRes?.data?.workouts || liftsRes?.data?.sessions || [];
      const racesData = racesRes?.data?.races || [];
      const meData = meRes?.data?.user || meRes?.data || {};
      const statsData = statsRes?.data || {};
      const readinessData = readinessRes?.data;

      setRuns(runsData.sort((a, b) => (getDateValue(b) || '').localeCompare(getDateValue(a) || '')));
      setLifts(liftsData.sort((a, b) => (getDateValue(b) || '').localeCompare(getDateValue(a) || '')));
      setRaces(racesData);
      setUser(meData);
      setStats(statsData);

      const score = readinessData?.readiness ?? readinessData?.readiness_score ?? readinessData?.score;
      setReadiness(Number.isFinite(Number(score)) ? String(score) : '--');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadDashboard();
    }, [loadDashboard])
  );

  const upcomingRace = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return races
      .map((race) => ({ ...race, _date: parseDate({ date: race.race_date }) }))
      .filter((race) => race._date && race._date > today)
      .sort((a, b) => a._date - b._date)[0] || null;
  }, [races]);

  const weeklySessions = useMemo(() => {
    const weekStart = startOfWeek(new Date());
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const runCount = runs.filter((run) => {
      const date = parseDate(run);
      return date && date >= weekStart && date <= weekEnd;
    }).length;

    const liftCount = lifts.filter((lift) => {
      const date = parseDate(lift);
      return date && date >= weekStart && date <= weekEnd;
    }).length;

    return runCount + liftCount;
  }, [runs, lifts]);

  const plannedSessions = useMemo(() => Number(user?.weekly_sessions ?? user?.plan_sessions_per_week ?? 0), [user]);
  const weekPct = plannedSessions > 0 ? Math.min(100, Math.round((weeklySessions / plannedSessions) * 100)) : 0;

  const [period, setPeriod] = useState('W');

  const periodRuns = useMemo(() => {
    const now = new Date();
    const boundary = new Date(now);

    if (period === 'D') {
      boundary.setHours(0, 0, 0, 0);
    } else if (period === 'W') {
      return runs.filter((run) => {
        const date = parseDate(run);
        if (!date) return false;
        return date >= startOfWeek(now);
      });
    } else if (period === 'M') {
      boundary.setMonth(now.getMonth() - 1);
    }

    if (period === 'All') return runs;
    return runs.filter((run) => {
      const date = parseDate(run);
      return date && date >= boundary;
    });
  }, [period, runs]);

  const periodMiles = useMemo(
    () => periodRuns.reduce((sum, run) => sum + getDistanceMiles(run), 0),
    [periodRuns]
  );

  const periodTime = useMemo(
    () => periodRuns.reduce((sum, run) => sum + getDurationSeconds(run), 0),
    [periodRuns]
  );

  const periodCalories = useMemo(
    () => periodRuns.reduce((sum, run) => sum + getCalories(run), 0),
    [periodRuns]
  );

  const mileageData = useMemo(() => getWeeksMileage(runs), [runs]);
  const previousWeekMiles = mileageData.length > 1 ? mileageData[mileageData.length - 2].miles : 0;

  const chart = useMemo(() => {
    const chartWidth = Math.max(width - 56, 240);
    const chartHeight = 160;
    const maxMiles = Math.max(...mileageData.map((x) => x.miles), 1);

    const points = mileageData.map((point, index) => {
      const x = (index / Math.max(mileageData.length - 1, 1)) * chartWidth;
      const y = chartHeight - (point.miles / maxMiles) * (chartHeight - 20) - 10;
      return { ...point, x, y };
    });

    const linePoints = points.map((p) => `${p.x},${p.y}`).join(' ');
    const areaPoints = `${linePoints} ${chartWidth},${chartHeight} 0,${chartHeight}`;

    return {
      chartWidth,
      chartHeight,
      points,
      linePoints,
      areaPoints
    };
  }, [mileageData, width]);

  const calendarDays = useMemo(() => {
    const start = startOfWeek(new Date());
    const today = new Date();
    return Array.from({ length: 7 }, (_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);

      const hasRun = runs.some((run) => {
        const date = parseDate(run);
        return date ? isSameDay(date, day) : false;
      });

      const hasLift = lifts.some((lift) => {
        const date = parseDate(lift);
        return date ? isSameDay(date, day) : false;
      });

      return {
        day,
        hasRun,
        hasLift,
        isToday: isSameDay(day, today)
      };
    });
  }, [lifts, runs]);

  const recentActivity = useMemo(() => {
    const runItems = runs.map((run) => ({
      ...run,
      _type: 'run',
      _date: parseDate(run)
    }));

    const liftItems = lifts.map((lift) => ({
      ...lift,
      _type: 'lift',
      _date: parseDate(lift)
    }));

    return [...runItems, ...liftItems]
      .filter((item) => item._date)
      .sort((a, b) => b._date - a._date)
      .slice(0, 5);
  }, [lifts, runs]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]}
      refreshControl={<RefreshControl tintColor="#EAB308" refreshing={refreshing} onRefresh={loadDashboard} />}
    >
      <View style={styles.headerRow}>
        <View style={styles.brandRow}>
          <View style={styles.logoMark} />
          <Text style={styles.brandText}>FORGE</Text>
        </View>

        <Pressable style={styles.readinessPill}>
          <Text style={styles.readinessText}>READINESS {readiness}</Text>
        </Pressable>
      </View>

      {upcomingRace && (
        <View style={styles.nextRaceCard}>
          <Text style={styles.metaLabel}>Next Race</Text>
          <Text style={styles.nextRaceTitle}>{upcomingRace.name || 'Race'}</Text>
          <Text style={styles.nextRaceDays}>
            {Math.max(0, Math.ceil((upcomingRace._date - new Date()) / 86400000))} days to go
          </Text>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.metaLabel}>This Week</Text>
        <Text style={styles.weekSummaryText}>
          {weeklySessions}/{plannedSessions} sessions - {weekPct}%
        </Text>
      </View>

      <View style={styles.card}>
        <View style={styles.toggleRow}>
          {['D', 'W', 'M', 'All'].map((value) => (
            <Pressable
              key={value}
              onPress={() => setPeriod(value)}
              style={[styles.toggleButton, period === value && styles.toggleButtonActive]}
            >
              <Text style={[styles.toggleText, period === value && styles.toggleTextActive]}>{value}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.bigMiles}>{periodMiles.toFixed(1)} mi</Text>

        <View style={styles.statsRow}>
          <View style={styles.statBlock}>
            <Text style={styles.statValue}>{periodRuns.length}</Text>
            <Text style={styles.statLabel}>Runs</Text>
          </View>
          <View style={styles.statBlock}>
            <Text style={styles.statValue}>{formatDuration(periodTime)}</Text>
            <Text style={styles.statLabel}>Time</Text>
          </View>
          <View style={styles.statBlock}>
            <Text style={styles.statValue}>{Math.round(periodCalories)}</Text>
            <Text style={styles.statLabel}>Cal</Text>
          </View>
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.sectionLabel}>Past 12 Weeks</Text>
          <Text style={styles.accentLabel}>{previousWeekMiles.toFixed(1)} mi last week</Text>
        </View>

        <Svg width={chart.chartWidth} height={chart.chartHeight} style={styles.chartSvg}>
          <Defs>
            <LinearGradient id="mileageFill" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#EAB308" stopOpacity="0.36" />
              <Stop offset="1" stopColor="#EAB308" stopOpacity="0.04" />
            </LinearGradient>
          </Defs>
          <Polygon points={chart.areaPoints} fill="url(#mileageFill)" />
          <Polyline points={chart.linePoints} fill="none" stroke="#EAB308" strokeWidth="3" />
        </Svg>

        <View style={styles.xAxisRow}>
          {chart.points.map((point, index) => {
            const prev = chart.points[index - 1];
            const showLabel = index === 0 || index === chart.points.length - 1 || point.start.getMonth() !== prev?.start.getMonth();
            return (
              <Text key={point.start.toISOString()} style={styles.axisLabel}>
                {showLabel ? point.label : ' '}
              </Text>
            );
          })}
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.calendarRow}>
          {calendarDays.map((dayItem, index) => {
            let markerText = '';
            if (dayItem.hasRun && dayItem.hasLift) markerText = 'R+L';
            else if (dayItem.hasRun) markerText = 'R';
            else if (dayItem.hasLift) markerText = 'L';

            return (
              <View key={`${dayItem.day.toISOString()}-${index}`} style={styles.dayCol}>
                <Text style={styles.dayLabel}>{DAY_LABELS[index]}</Text>
                <View
                  style={[
                    styles.dayCircle,
                    markerText ? styles.dayCircleActive : null,
                    dayItem.isToday ? styles.dayCircleToday : null,
                    markerText === 'R+L' ? styles.dayCircleWide : null
                  ]}
                >
                  <Text style={[styles.dayMarker, markerText ? styles.dayMarkerActive : null]}>{markerText}</Text>
                </View>
              </View>
            );
          })}
        </View>
      </View>

      <Text style={styles.recentTitle}>Recent Activity</Text>
      <View style={styles.activityList}>
        {recentActivity.map((item, index) => (
          <Pressable key={`${item._type}-${item.id || index}`} style={styles.activityCard}>
            <View style={styles.rowBetween}>
              <View style={styles.activityLeft}>
                <View style={[styles.typePill, item._type === 'run' ? styles.runPill : styles.liftPill]}>
                  <Text style={[styles.typePillText, item._type === 'run' ? styles.runPillText : styles.liftPillText]}>
                    {item._type === 'run' ? 'Run' : 'Lift'}
                  </Text>
                </View>

                {item._type === 'run' ? (
                  <Text style={styles.activityText}>
                    {getDistanceMiles(item).toFixed(2)} mi - {formatPace(getDurationSeconds(item), getDistanceMiles(item))} -{' '}
                    {formatDuration(getDurationSeconds(item))} - {Math.round(getCalories(item))} cal
                  </Text>
                ) : (
                  <Text style={styles.activityText}>
                    {item.name || item.exercise_name || 'Lift Session'} -
                    {' '}{Array.isArray(item.sets) ? item.sets.length : Number(item.set_count || 0)} sets/
                    {Array.isArray(item.sets)
                      ? item.sets.reduce((sum, set) => sum + Number(set.reps || 0), 0)
                      : Number(item.total_reps || 0)} reps
                  </Text>
                )}
              </View>

              <Text style={styles.activityDate}>{formatShortDate(getDateValue(item))}</Text>
            </View>
          </Pressable>
        ))}

        {!recentActivity.length && (
          <View style={styles.activityCard}>
            <Text style={styles.emptyText}>No recent activity yet.</Text>
          </View>
        )}
      </View>

      <Pressable onPress={() => navigation.navigate('LogRun')} style={styles.logRunButton}>
        <Text style={styles.logRunButtonText}>Log Run</Text>
      </Pressable>

      <Pressable onPress={() => navigation.navigate('LogLift')} style={styles.logLiftButton}>
        <Text style={styles.logLiftButtonText}>Log Lift</Text>
      </Pressable>

      <View style={styles.footerPad} />
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
    paddingBottom: 24
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  logoMark: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: COLORS.accent
  },
  brandText: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 0.8
  },
  readinessPill: {
    borderWidth: 1,
    borderColor: COLORS.accent,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6
  },
  readinessText: {
    color: COLORS.accent,
    fontSize: 11,
    fontWeight: '700'
  },
  card: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12
  },
  nextRaceCard: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accent,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12
  },
  metaLabel: {
    color: COLORS.subtext,
    fontSize: 12,
    marginBottom: 4
  },
  nextRaceTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700'
  },
  nextRaceDays: {
    color: COLORS.accent,
    fontSize: 14,
    marginTop: 4,
    fontWeight: '700'
  },
  weekSummaryText: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700'
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10
  },
  toggleButton: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12
  },
  toggleButtonActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent
  },
  toggleText: {
    color: COLORS.subtext,
    fontWeight: '700',
    fontSize: 12
  },
  toggleTextActive: {
    color: '#000000'
  },
  bigMiles: {
    color: COLORS.text,
    fontSize: 34,
    fontWeight: '800'
  },
  statsRow: {
    flexDirection: 'row',
    marginTop: 8,
    gap: 16
  },
  statBlock: {
    flex: 1
  },
  statValue: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700'
  },
  statLabel: {
    color: COLORS.subtext,
    fontSize: 11,
    marginTop: 2
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  sectionLabel: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '700'
  },
  accentLabel: {
    color: COLORS.accent,
    fontSize: 12,
    fontWeight: '700'
  },
  chartSvg: {
    marginTop: 10
  },
  xAxisRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4
  },
  axisLabel: {
    width: 28,
    color: COLORS.subtext,
    fontSize: 10,
    textAlign: 'center'
  },
  calendarRow: {
    flexDirection: 'row',
    justifyContent: 'space-between'
  },
  dayCol: {
    alignItems: 'center',
    flex: 1
  },
  dayLabel: {
    color: COLORS.subtext,
    fontSize: 11,
    marginBottom: 6
  },
  dayCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.input
  },
  dayCircleWide: {
    width: 42,
    borderRadius: 14
  },
  dayCircleActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent
  },
  dayCircleToday: {
    borderColor: COLORS.accent,
    borderWidth: 2
  },
  dayMarker: {
    color: COLORS.subtext,
    fontSize: 9,
    fontWeight: '700'
  },
  dayMarkerActive: {
    color: '#000000'
  },
  recentTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 10,
    marginTop: 2
  },
  activityList: {
    marginBottom: 12
  },
  activityCard: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8
  },
  activityLeft: {
    flex: 1,
    paddingRight: 8
  },
  typePill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
    marginBottom: 6
  },
  runPill: {
    backgroundColor: COLORS.accent
  },
  liftPill: {
    backgroundColor: COLORS.border
  },
  typePillText: {
    fontSize: 11,
    fontWeight: '700'
  },
  runPillText: {
    color: '#000000'
  },
  liftPillText: {
    color: COLORS.subtext
  },
  activityText: {
    color: COLORS.text,
    fontSize: 12,
    lineHeight: 18
  },
  activityDate: {
    color: COLORS.subtext,
    fontSize: 11
  },
  emptyText: {
    color: COLORS.subtext,
    fontSize: 13
  },
  logRunButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 10
  },
  logRunButtonText: {
    color: '#000000',
    fontSize: 15,
    fontWeight: '700'
  },
  logLiftButton: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center'
  },
  logLiftButtonText: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '700'
  },
  footerPad: {
    height: 10
  }
});
