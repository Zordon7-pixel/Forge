import React, { useCallback, useMemo, useState } from 'react';
import {
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import Svg, { Circle, Defs, LinearGradient, Polygon, Polyline, Stop } from 'react-native-svg';
import { HelpCircle, MessageSquare, Moon, Sun } from 'lucide-react-native';

// Circular readiness gauge — matches web ReadinessGauge
function ReadinessGauge({ score }) {
  const cx = 60, cy = 60, r = 48;
  const circumference = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Number(score) || 0));
  const dash = (pct / 100) * circumference;
  const color = pct >= 80 ? '#22c55e' : pct >= 50 ? '#EAB308' : '#ef4444';
  return (
    <View style={{ alignItems: 'center' }}>
      <Svg width={120} height={120}>
        <Circle cx={cx} cy={cy} r={r} fill="none" stroke="#2c3345" strokeWidth="8" />
        <Circle
          cx={cx} cy={cy} r={r}
          fill="none" stroke={color} strokeWidth="8"
          strokeDasharray={`${dash} ${circumference - dash}`}
          strokeLinecap="round"
          rotation="-90"
          originX={cx} originY={cy}
        />
      </Svg>
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 26, fontWeight: '900', color: color }}>{score}</Text>
        <Text style={{ fontSize: 9, color: '#64748b', letterSpacing: 1, textTransform: 'uppercase' }}>Readiness</Text>
      </View>
    </View>
  );
}

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

export default function Dashboard() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [refreshing, setRefreshing] = useState(false);
  const [runs, setRuns] = useState([]);
  const [lifts, setLifts] = useState([]);
  const [races, setRaces] = useState([]);
  const [user, setUser] = useState(null);
  const [stats, setStats] = useState(null);
  const [readiness, setReadiness] = useState('--');
  const [compliance, setCompliance] = useState(null);
  const [activeInjury, setActiveInjury] = useState(null);
  const [checkedInToday, setCheckedInToday] = useState(false);
  const [darkMode, setDarkMode] = useState(true);

  const loadDashboard = useCallback(async () => {
    setRefreshing(true);
    try {
      const [runsRes, liftsRes, racesRes, meRes, statsRes, readinessRes, complianceRes, injuryRes, checkinRes] = await Promise.all([
        api.get('/runs').catch(() => ({ data: [] })),
        api.get('/lifts').catch(() => ({ data: [] })),
        api.get('/races').catch(() => ({ data: { races: [] } })),
        api.get('/auth/me').catch(() => ({ data: {} })),
        api.get('/auth/me/stats').catch(() => ({ data: {} })),
        api.get('/checkin/streak').catch(() => ({ data: null })),
        api.get('/plans/compliance').catch(() => ({ data: null })),
        api.get('/injury/active').catch(() => ({ data: { injuries: [] } })),
        api.get('/checkin/today').catch(() => ({ data: null }))
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
      setCompliance(complianceRes?.data || null);
      setActiveInjury((injuryRes?.data?.injuries || [])[0] || null);
      setCheckedInToday(!!checkinRes?.data);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadDashboard();
    }, [loadDashboard])
  );

  const dismissActiveInjury = useCallback(async () => {
    try {
      await api.delete('/injury/active');
    } catch {
      await api.post('/injury/resolve').catch(() => {});
    } finally {
      setActiveInjury(null);
    }
  }, []);

  const openQuickCheckin = useCallback(() => {
    const checkinRouteNames = ['CheckIn', 'QuickCheckin', 'QuickCheckIn'];
    let navigatorRef = navigation;
    const routeNames = new Set();

    while (navigatorRef) {
      const state = navigatorRef.getState?.();
      (state?.routeNames || []).forEach((name) => routeNames.add(name));
      navigatorRef = navigatorRef.getParent?.();
    }

    const target = checkinRouteNames.find((name) => routeNames.has(name)) || 'Profile';
    navigation.navigate(target);
  }, [navigation]);

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
        {/* Left: FORGE logo image */}
        <Image
          source={require('../../assets/icon.png')}
          style={styles.logoMark}
        />

        {/* Center: READINESS label + yellow bar */}
        <View style={styles.readinessCenter}>
          <Text style={styles.readinessLabel}>READINESS</Text>
          <View style={styles.readinessBar} />
        </View>

        {/* Right: icons */}
        <View style={styles.headerIcons}>
          <Pressable onPress={() => setDarkMode(d => !d)} hitSlop={8}>
            {darkMode
              ? <Moon size={18} color="#64748b" />
              : <Sun size={18} color="#64748b" />
            }
          </Pressable>
          <Pressable hitSlop={8}>
            <MessageSquare size={18} color="#64748b" />
          </Pressable>
          <Pressable hitSlop={8}>
            <HelpCircle size={18} color="#64748b" />
          </Pressable>
        </View>
      </View>

      {/* Injury / Recovery Mode Banner */}
      {activeInjury && (
        <View style={styles.injuryBanner}>
          <View style={{ flex: 1 }}>
            <Text style={styles.injuryTitle}>
              Recovery Mode — {activeInjury.body_part || 'Injury'} — Est. return: {activeInjury.date || '--'}
            </Text>
            <Text style={styles.injurySubtext}>
              Your plan has been adjusted for recovery. Focus on PT and low-impact activity.
            </Text>
          </View>
          <Pressable onPress={dismissActiveInjury} style={styles.injuryDismiss}>
            <Text style={{ color: '#0f1117', fontSize: 16, fontWeight: '700' }}>✕</Text>
          </Pressable>
        </View>
      )}

      {/* Next Race — before compliance, within 60 days */}
      {upcomingRace && Math.ceil((upcomingRace._date - new Date()) / 86400000) <= 60 && (
        <View style={styles.nextRaceCard}>
          <Text style={styles.metaLabel}>Next Race</Text>
          <Text style={styles.nextRaceTitle}>{upcomingRace.name || upcomingRace.race_name || 'Race'}</Text>
          <Text style={styles.nextRaceDays}>
            {Math.max(0, Math.ceil((upcomingRace._date - new Date()) / 86400000))} days to go
          </Text>
        </View>
      )}

      {/* This Week + compliance progress */}
      {compliance ? (
        <View style={styles.card}>
          <Text style={styles.weekSummaryText}>
            This Week: {compliance.completed}/{compliance.planned} sessions — {compliance.score}%
          </Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.min(compliance.score, 100)}%` }]} />
          </View>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.weekSummaryText}>
            This Week: {weeklySessions}/{plannedSessions} sessions — {weekPct}%
          </Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.min(weekPct, 100)}%` }]} />
          </View>
        </View>
      )}

      {/* Quick Check-in CTA */}
      {!checkedInToday && (
        <Pressable style={styles.checkinCard} onPress={openQuickCheckin}>
          <Text style={styles.checkinTitle}>Quick check-in — 3 taps</Text>
          <Text style={styles.checkinSub}>Help me adjust today's plan around your day</Text>
        </Pressable>
      )}

      {/* Ready to Run */}
      <View style={styles.warmupCard}>
        <Text style={styles.warmupTitle}>Ready to Run?</Text>
        <Text style={styles.warmupSub}>Dynamic warm-up reduces injury risk and improves performance.</Text>
        <Pressable style={styles.warmupButton} onPress={() => navigation.navigate('Run')}>
          <Text style={styles.warmupButtonText}>Start Warm-Up</Text>
        </Pressable>
        <Pressable onPress={() => navigation.navigate('LogRun')}>
          <Text style={styles.warmupSkip}>Skip warm-up</Text>
        </Pressable>
      </View>

      {/* Training Readiness — text unlock prompt or gauge */}
      {readiness === '--' ? (
        <Text style={styles.readinessUnlock}>
          Complete your daily check-in and sync your watch to unlock
        </Text>
      ) : (
        <View style={styles.card}>
          <ReadinessGauge score={readiness} />
          <Text style={[styles.metaLabel, { textAlign: 'center', marginTop: 8 }]}>
            Based on your HRV, sleep, soreness, and energy levels
          </Text>
        </View>
      )}

      {/* 7-day calendar — BEFORE stats */}
      <View style={styles.card}>
        <Text style={styles.metaLabel}>This Week</Text>
        <View style={styles.calendarRow}>
          {calendarDays.map((dayItem, index) => {
            let markerText = '';
            if (dayItem.hasRun && dayItem.hasLift) markerText = 'R+L';
            else if (dayItem.hasRun) markerText = 'R';
            else if (dayItem.hasLift) markerText = 'L';
            const dayAbbr = dayItem.day.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 3);
            return (
              <View key={`${dayItem.day.toISOString()}-${index}`} style={styles.dayCol}>
                <Text style={styles.dayLabel}>{dayAbbr}</Text>
                <View
                  style={[
                    styles.dayCircle,
                    markerText ? styles.dayCircleActive : null,
                    dayItem.isToday ? styles.dayCircleToday : null,
                    markerText === 'R+L' ? styles.dayCircleWide : null
                  ]}
                >
                  <Text style={[styles.dayMarker, markerText ? styles.dayMarkerActive : null]}>{markerText || '·'}</Text>
                </View>
              </View>
            );
          })}
        </View>
      </View>

      {/* Stats with period selector */}
      <View style={styles.card}>
        <View style={styles.toggleRow}>
          {[{key:'D',label:'D'},{key:'W',label:'W'},{key:'M',label:'M'},{key:'All',label:'All'}].map(({key,label}) => (
            <Pressable
              key={key}
              onPress={() => setPeriod(key)}
              style={[styles.toggleButton, period === key && styles.toggleButtonActive]}
            >
              <Text style={[styles.toggleText, period === key && styles.toggleTextActive]}>{label}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.periodLabel}>
          {period === 'D' ? 'Today' : period === 'W' ? 'This Week' : period === 'M' ? 'This Month' : 'All Time'}
        </Text>

        <Text style={styles.bigMiles}>{periodMiles.toFixed(1)}</Text>
        <Text style={styles.bigMilesLabel}>Mis</Text>

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

      {/* 12-week trend chart — separate card */}
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

      {/* Recent Activity — matches web section card with yellow title border */}
      <View style={styles.recentSection}>
        <Text style={styles.recentTitle}>Recent Activity</Text>
        <View style={styles.activityList}>
          {recentActivity.map((item, index) => (
            <Pressable
              key={`${item._type}-${item.id || index}`}
              style={[styles.activityCard, item._type === 'run' ? styles.activityCardRun : styles.activityCardLift]}
            >
              <View style={styles.rowBetween}>
                <View style={{ flex: 1 }}>
                  <View style={styles.rowBetween}>
                    <View style={[styles.typePill, item._type === 'run' ? styles.runPill : styles.liftPill]}>
                      <Text style={[styles.typePillText, item._type === 'run' ? styles.runPillText : styles.liftPillText]}>
                        {item._type === 'run' ? 'Run' : 'Lift'}
                      </Text>
                    </View>
                    <Text style={styles.activityDate}>
                      {item._date ? item._date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '--'}
                    </Text>
                  </View>

                  {item._type === 'run' ? (
                    <View style={styles.activityStatsRow}>
                      <Text style={styles.activityStat}>{getDistanceMiles(item).toFixed(2)} mi</Text>
                      <Text style={styles.activityStat}>{formatPace(getDurationSeconds(item), getDistanceMiles(item))}</Text>
                      <Text style={styles.activityStat}>{formatDuration(getDurationSeconds(item))}</Text>
                      {getCalories(item) > 0 && <Text style={styles.activityStat}>{Math.round(getCalories(item))} cal</Text>}
                    </View>
                  ) : (
                    <Text style={styles.activityText}>
                      {item.exercise_name || item.name || 'Workout'}
                      {item.sets ? `  ·  ${item.sets} sets · ${item.reps} reps · ${item.weight_lbs} lbs` : ''}
                    </Text>
                  )}
                </View>
              </View>
            </Pressable>
          ))}

          {!recentActivity.length && (
            <View style={styles.activityCard}>
              <Text style={styles.emptyText}>No recent activity yet.</Text>
            </View>
          )}
        </View>
      </View>

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
  logoMark: {
    width: 36,
    height: 36,
    borderRadius: 10
  },
  readinessCenter: {
    alignItems: 'center',
    flex: 1
  },
  readinessLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: '#64748b',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 3
  },
  readinessBar: {
    width: 32,
    height: 3,
    borderRadius: 2,
    backgroundColor: COLORS.accent
  },
  readinessUnlock: {
    fontSize: 13,
    color: COLORS.subtext,
    textAlign: 'left',
    marginBottom: 12,
    lineHeight: 18
  },
  periodLabel: {
    fontSize: 12,
    color: COLORS.subtext,
    marginBottom: 4,
    marginTop: 2
  },
  headerIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14
  },
  card: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12
  },
  injuryBanner: {
    backgroundColor: 'rgba(234,179,8,0.2)',
    borderWidth: 1,
    borderColor: '#EAB308',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  injuryTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f1117',
    marginBottom: 2,
  },
  injurySubtext: {
    fontSize: 11,
    color: '#0f1117',
  },
  injuryDismiss: {
    padding: 4,
  },
  progressTrack: {
    height: 6,
    backgroundColor: '#1e2433',
    borderRadius: 3,
    marginTop: 8,
    overflow: 'hidden',
  },
  progressFill: {
    height: 6,
    backgroundColor: '#EAB308',
    borderRadius: 3,
  },
  checkinCard: {
    backgroundColor: 'rgba(234,179,8,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(234,179,8,0.3)',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  checkinTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#EAB308',
    marginBottom: 2,
  },
  checkinSub: {
    fontSize: 12,
    color: '#94a3b8',
  },
  warmupCard: {
    backgroundColor: '#171c27',
    borderWidth: 1,
    borderColor: '#2c3345',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    marginBottom: 12,
  },
  warmupTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#FFFFFF',
    marginBottom: 6,
  },
  warmupSub: {
    fontSize: 13,
    color: '#94a3b8',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 18,
  },
  warmupButton: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: '#EAB308',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  warmupButtonText: {
    fontSize: 12,
    fontWeight: '900',
    color: '#000',
    textAlign: 'center',
  },
  warmupSkip: {
    fontSize: 14,
    color: '#94a3b8',
    paddingVertical: 8,
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
    fontSize: 48,
    fontWeight: '900',
    marginTop: 4
  },
  bigMilesLabel: {
    color: COLORS.subtext,
    fontSize: 13,
    marginBottom: 8
  },
  statsRow: {
    flexDirection: 'row',
    marginTop: 8,
    gap: 16
  },
  statBlock: {
    flex: 1,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    padding: 8
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
  recentSection: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    marginBottom: 12
  },
  recentTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(234,179,8,0.45)'
  },
  activityList: {
    gap: 8
  },
  activityCard: {
    backgroundColor: COLORS.input,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    borderLeftWidth: 4
  },
  activityCardRun: {
    borderLeftColor: COLORS.accent
  },
  activityCardLift: {
    borderLeftColor: COLORS.text
  },
  activityStatsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 6
  },
  activityStat: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '700'
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
    backgroundColor: 'rgba(139,92,246,0.15)'
  },
  typePillText: {
    fontSize: 11,
    fontWeight: '700'
  },
  runPillText: {
    color: '#000000'
  },
  liftPillText: {
    color: '#a78bfa'
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
// v1.0.1 1772771761
