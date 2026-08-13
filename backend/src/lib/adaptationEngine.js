// Forged Hybrid H4 transparent adaptation engine.
// Pure and deterministic: no DB, network, framework, or wall-clock dependency.

const planSchema = require('./planSchema');
const checkinOverride = require('./checkinOverride');

const HARD_RUN_PATTERN = /(long|quality|tempo|threshold|interval|hill|hard|speed|vo2|race|zone 3|zone 4|zone 5|z3|z4|z5)/i;
const HEALTH_STALE = new Set(['stale', 'suspect', 'missing', 'no_data', 'unknown']);
const MODERATE_INJURY_WINDOW_DAYS = 14;
const MODERATE_INJURY_VOLUME_MULTIPLIER = 0.75;
// Product prescription policy, not a health-benefit or medical threshold.
// FORGE-RACE-TRAVEL-ADAPTATION-SPEC.md already establishes 20 minutes as the
// repository's conservative executable recovery-run dose. Adaptations may be
// distance-only, so 1.5 miles is the paired product guard against the known
// 0.5-0.8 mile token-run leak. We never increase a reduced dose to these floors:
// an under-floor or unquantified run becomes an explicit lower-strain choice.
const MIN_EFFECTIVE_RECOVERY_RUN_MINUTES = 20;
const MIN_EFFECTIVE_RECOVERY_RUN_MILES = 1.5;

function parseISODate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toISODate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(iso, amount) {
  const date = parseISODate(iso);
  if (!date) return null;
  return toISODate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount, 12));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  return JSON.stringify(value);
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function compareISO(a, b) {
  const left = parseISODate(a);
  const right = parseISODate(b);
  if (!left || !right) return 0;
  return left.getTime() - right.getTime();
}

function daysBetweenISO(laterISO, earlierISO) {
  const later = parseISODate(laterISO);
  const earlier = parseISODate(earlierISO);
  if (!later || !earlier) return null;
  return Math.round((later.getTime() - earlier.getTime()) / 86400000);
}

function isWithin(date, start, end) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))
    && compareISO(date, start) >= 0
    && compareISO(date, end) <= 0;
}

function normalizeLifeFlags(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function hasCheckinSignal(checkin = {}) {
  if (!checkin || typeof checkin !== 'object') return false;
  return ['legs', 'drive', 'feeling', 'sleep_hours', 'time_available'].some((key) => (
    checkin[key] !== undefined && checkin[key] !== null && checkin[key] !== ''
  )) || normalizeLifeFlags(checkin.life_flags).length > 0;
}

function normalizeAxis(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 3 ? parsed : null;
}

function isHardRun(session = {}) {
  if (planSchema.kindFromSession(session) !== 'run') return false;
  return HARD_RUN_PATTERN.test([
    session.title,
    session.type,
    session.workout_type,
    session.intensity,
    session.target_zone,
    session.description,
  ].filter(Boolean).join(' '));
}

function sessionSummary(session = {}) {
  const kind = planSchema.kindFromSession(session);
  if (kind === 'lift') return session.title || session.focus || 'Strength session';
  if (kind === 'rest') return 'Rest';
  const miles = Number(session.distance_miles ?? session.distance ?? session.miles);
  const duration = Number(session.duration_min ?? session.duration_minutes ?? session.minutes ?? session.time_minutes);
  const bits = [session.title || session.type || 'Run'];
  if (Number.isFinite(miles) && miles > 0) bits.push(`${Math.round(miles * 10) / 10} mi`);
  else if (Number.isFinite(duration) && duration > 0) bits.push(`${Math.round(duration)} min`);
  if (session.intensity) bits.push(session.intensity);
  return bits.filter(Boolean).join(' - ');
}

function firstNumericSessionValue(session = {}, keys = []) {
  for (const key of keys) {
    const value = Number(session[key]);
    if (Number.isFinite(value) && value > 0) return { key, value };
  }
  return null;
}

function sessionIdFor(day, session, sessionIndex, dayIndex) {
  return planSchema.sessionIdentifier(day, session, sessionIndex, dayIndex);
}

function iterateDays(plan, visitor) {
  const weeks = Array.isArray(plan && plan.weeks) ? plan.weeks : [];
  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    const week = weeks[weekIndex] || {};
    const entries = planSchema.getDayEntries(week);
    for (let dayIndex = 0; dayIndex < entries.length; dayIndex += 1) {
      visitor({
        week,
        weekIndex,
        day: entries[dayIndex],
        dayIndex,
        entries,
        entriesKey: planSchema.dayEntriesKey(week),
      });
    }
  }
}

function allDatedSessions(plan, start, end) {
  const result = [];
  iterateDays(plan, ({ weekIndex, day, dayIndex }) => {
    if (!isWithin(day && day.date, start, end)) return;
    const sessions = planSchema.daySessions(day);
    sessions.forEach((session, sessionIndex) => {
      result.push({
        weekIndex,
        dayIndex,
        date: day.date,
        day,
        session,
        sessionIndex,
        sessionId: sessionIdFor(day, session, sessionIndex, dayIndex),
        kind: planSchema.kindFromSession(session),
      });
    });
  });
  return result;
}

function metricValue(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw.value ?? raw.score ?? raw.readinessScore ?? null;
  }
  return raw;
}

function metricFreshness(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.suspect === true) return 'suspect';
    const freshness = String(raw.freshness || '').toLowerCase();
    if (freshness) return freshness;
    if (raw.fresh === true) return 'fresh';
  }
  return 'unknown';
}

function metricAsOf(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.asOf || raw.as_of || null : null;
}

function isUsableHealthMetric(raw) {
  const value = metricValue(raw);
  const freshness = metricFreshness(raw);
  if (value === null || value === undefined || value === '') return false;
  if (HEALTH_STALE.has(freshness)) return false;
  return freshness === 'fresh';
}

function freshnessLabel(raw) {
  const freshness = metricFreshness(raw);
  const asOf = metricAsOf(raw);
  return asOf ? `${freshness} as of ${String(asOf).slice(0, 10)}` : freshness;
}

function firstFreshMetric(healthSignals = {}, keys = []) {
  const metrics = healthSignals.metrics || {};
  for (const key of keys) {
    const metric = metrics[key] ?? healthSignals[key];
    if (isUsableHealthMetric(metric)) return { key, metric, value: Number(metricValue(metric)) };
  }
  return null;
}

function buildHealthEvidence(healthSignals = {}) {
  const evidence = [];
  const drivers = [];
  const addDriver = (signal, metric, detail) => {
    evidence.push({
      signal,
      source: 'apple_health',
      objective: true,
      freshness: freshnessLabel(metric),
      detail,
    });
    drivers.push(signal);
  };

  const readiness = firstFreshMetric(healthSignals, ['readinessScore', 'readiness_score']);
  if (readiness && Number.isFinite(readiness.value) && readiness.value < 70) {
    addDriver(
      'readiness',
      readiness.metric,
      `Objective Apple Health readiness is ${Math.round(readiness.value)}, below the normal training threshold.`
    );
  }

  const sleep = firstFreshMetric(healthSignals, ['sleepHoursLastNight', 'sleep_hours_last_night', 'sleep']);
  if (sleep && Number.isFinite(sleep.value) && sleep.value < 6) {
    addDriver(
      'sleep',
      sleep.metric,
      `Objective Apple Health sleep is ${Math.round(sleep.value * 10) / 10}h, below the recovery target.`
    );
  }

  const hrv = firstFreshMetric(healthSignals, ['hrvMs', 'hrv_ms', 'hrv']);
  if (hrv && Number.isFinite(hrv.value) && hrv.value < 35) {
    addDriver(
      'hrv',
      hrv.metric,
      `Objective Apple Health HRV is ${Math.round(hrv.value)} ms, which indicates recovery stress.`
    );
  }

  const restingHr = firstFreshMetric(healthSignals, ['restingHeartRate', 'resting_heart_rate', 'rhr']);
  if (restingHr && Number.isFinite(restingHr.value) && restingHr.value >= 85) {
    addDriver(
      'resting_hr',
      restingHr.metric,
      `Objective Apple Health resting heart rate is ${Math.round(restingHr.value)} bpm, above the preferred range.`
    );
  }

  const load = firstFreshMetric(healthSignals, ['acuteChronicLoadRatio', 'acute_chronic_load_ratio', 'loadRatio']);
  if (load && Number.isFinite(load.value) && (load.value > 1.4 || load.value < 0.5)) {
    addDriver(
      'load',
      load.metric,
      `Objective Apple Health load ratio is ${Math.round(load.value * 100) / 100}:1, outside the preferred range.`
    );
  }

  const severe = evidence.some((item) => item.signal === 'readiness' && /readiness is ([0-4][0-9])/.test(item.detail))
    || (readiness && readiness.value < 45)
    || (sleep && sleep.value < 5)
    || (hrv && hrv.value < 28);
  const caution = evidence.length > 0;
  return {
    evidence,
    drivers,
    severity: severe ? 'rest' : caution ? 'reduce' : 'none',
  };
}

function buildCheckinEvidence(checkin = {}, todaySessions = []) {
  if (!hasCheckinSignal(checkin)) return { evidence: [], action: 'keep', patch: {}, safety: false, directive: null };
  const runToday = todaySessions.find((item) => item.kind === 'run');
  const flags = normalizeLifeFlags(checkin.life_flags);
  const legs = normalizeAxis(checkin.legs);
  const feeling = Number(checkin.feeling || 3);
  const timeAvailable = Number(checkin.time_available || 60);
  const sleepHours = checkin.sleep_hours === null || checkin.sleep_hours === undefined || checkin.sleep_hours === ''
    ? null
    : Number(checkin.sleep_hours);
  let action = checkinOverride.deriveAction(checkin);
  let patch = runToday ? checkinOverride.buildPatch(action, runToday.session, checkin) : {};
  const heavyLegsOnly = legs === 1
    && action === 'recovery_swap'
    && !flags.some((flag) => ['sick', 'injured', 'not_well', 'sore'].includes(flag))
    && feeling > 2
    && !(timeAvailable > 0 && timeAvailable <= 30)
    && !flags.some((flag) => ['long_shift', 'traveling'].includes(flag))
    && !(Number.isFinite(sleepHours) && sleepHours < 6);
  if (heavyLegsOnly) {
    action = 'keep';
    patch = runToday && isHardRun(runToday.session) ? patchRunForHeavyLegs(runToday.session) : {};
  }
  const includeWhenKeep = heavyLegsOnly && Object.keys(patch || {}).length > 0;
  const directive = checkinOverride.buildDirective(checkin, action, patch, Boolean(runToday), 0);
  const safety = flags.includes('sick') || flags.includes('injured');
  const drivers = Array.isArray(directive.drivers) ? directive.drivers : [];
  const evidence = drivers.length
    ? drivers.map((driver) => ({
      signal: driver.label || 'check-in',
      source: 'checkin',
      objective: false,
      freshness: 'today',
      detail: `Subjective check-in: ${driver.detail || driver.label || 'daily check-in signal'}`,
    }))
    : [{
      signal: 'check-in',
      source: 'checkin',
      objective: false,
      freshness: 'today',
      detail: 'Subjective check-in was recorded and does not require a calendar change.',
    }];
  return { evidence, action, patch, safety, directive, includeWhenKeep };
}

function buildCompletionEvidence(completion = {}) {
  if (!completion || typeof completion !== 'object') return { evidence: [], driver: false };
  if (completion.adaptationEnabled === false) return { evidence: [], driver: false };
  const adherence = Number(completion.adherenceRate ?? completion.adherence_rate);
  const missed = Number(completion.missedWorkouts ?? completion.missed_workouts ?? completion.missedCount ?? 0);
  const missedRuns = Number(completion.missedRuns ?? completion.missedRunCount ?? 0);
  const missedLifts = Number(completion.missedLifts ?? completion.missedLiftCount ?? 0);
  const daysInactive = Number(completion.daysInactive ?? completion.days_inactive);
  const daysSinceRun = Number(completion.daysSinceRun ?? completion.days_since_run);
  const lastRunDate = completion.lastRunDate || completion.last_run_date || null;
  const runGapEpisodeKey = completion.runGapEpisodeKey || completion.run_gap_episode_key
    || (lastRunDate ? `run-gap:${lastRunDate}` : null);
  const gapPromptEnabled = completion.gapPromptEnabled !== false;
  const runGap = gapPromptEnabled
    && Boolean(lastRunDate)
    && Number.isFinite(daysSinceRun)
    && daysSinceRun >= 7;
  const driver = runGap || (Number.isFinite(adherence) && adherence < 0.65) || missed >= 2 || missedRuns >= 2;
  if (!driver) return { evidence: [], driver: false };
  const details = [];
  if (Number.isFinite(adherence)) details.push(`${Math.round(adherence * 100)}% recent adherence`);
  if (missedRuns || missedLifts || missed) details.push(`${missedRuns || 0} missed runs, ${missedLifts || 0} missed lifts`);
  if (runGap) details.unshift(`${Math.round(daysSinceRun)} days since the last logged run`);
  return {
    driver: true,
    runGap,
    trainingGap: runGap,
    daysSinceRun: runGap ? Math.round(daysSinceRun) : null,
    daysInactive: runGap ? Math.round(daysSinceRun) : null,
    lastRunDate: runGap ? lastRunDate : null,
    episodeKey: runGap ? runGapEpisodeKey : null,
    weeklyMileageBaseline: Math.max(0, Number(completion.weeklyMileageBaseline || 0)),
    evidence: [{
      signal: runGap ? 'run_gap' : 'adherence',
      source: 'completion',
      objective: true,
      freshness: completion.freshness || 'recent',
      daysSinceRun: runGap ? Math.round(daysSinceRun) : null,
      daysInactive: runGap ? Math.round(daysSinceRun) : null,
      lastRunDate: runGap ? lastRunDate : null,
      episodeKey: runGap ? runGapEpisodeKey : null,
      missedWorkouts: Math.max(0, missed || 0),
      detail: runGap
        ? `Forged Hybrid has not seen a logged run for ${Math.round(daysSinceRun)} days. Lifting and life events do not hide the running gap; a bounded easy re-entry is offered without treating it as failure.`
        : `Logged completion history shows ${details.join('; ') || 'recent missed sessions'}, so the next hard run is reduced instead of forcing a catch-up.`
    }],
  };
}

function isDemandingRun(session) {
  return isHardRun(session) || (planSchema.kindFromSession(session) === 'run' && /(steady|moderate|progression|zone 2-3)/i.test(
    [session.title, session.type, session.intensity, session.target_zone].filter(Boolean).join(' ')
  ));
}

function buildRecentRunEvidence(recentRunLoad = {}) {
  const latest = recentRunLoad?.protectiveRun || recentRunLoad?.latestRun;
  const protection = recentRunLoad?.protection;
  if (!latest || !protection?.active) return { evidence: [], driver: false, latest: null, protection: null };
  const details = [
    `${Number(latest.distanceMiles || 0).toFixed(1)} mi`,
    latest.paceLabel || null,
    latest.durationMinutes ? `${Math.round(Number(latest.durationMinutes))} min` : null,
    latest.avgHeartRate ? `avg HR ${Math.round(Number(latest.avgHeartRate))}` : null,
  ].filter(Boolean).join(', ');
  const evidence = [{
    signal: 'recent run load',
    source: 'recent_run',
    objective: true,
    freshness: latest.daysSince === 0 ? 'today' : latest.daysSince === 1 ? 'yesterday' : `${latest.daysSince} days ago`,
    detail: `Logged run: ${details}. Duplicate running, hard sessions, and lower-body loading are protected during the next 24-72 hours.`,
  }];
  if (latest.postRunCaution) {
    const checkinDetails = [
      latest.postRunPain && latest.postRunPain !== 'none' ? `${latest.postRunPain} pain` : null,
      latest.postRunEnergy === 'low' ? 'low energy' : null,
    ].filter(Boolean).join(' and ');
    evidence.push({
      signal: 'post-run check-in',
      source: 'post_run_checkin',
      objective: false,
      freshness: latest.daysSince === 0 ? 'today' : latest.daysSince === 1 ? 'yesterday' : `${latest.daysSince} days ago`,
      detail: `The athlete reported ${checkinDetails}; the next run and lower-body load stay conservative.`,
    });
  }
  return {
    driver: true,
    latest,
    protection,
    evidence,
  };
}

function formatBodyPart(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, ' ') || 'unspecified body part';
}

function normalizeInjurySeverity(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (['severe', 'high'].includes(raw)) return 'severe';
  if (['moderate', 'medium'].includes(raw)) return 'moderate';
  if (['mild', 'low', 'minor'].includes(raw)) return 'mild';
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  if (score >= 8) return 'severe';
  if (score >= 5) return 'moderate';
  if (score >= 1) return 'mild';
  return null;
}

function injuryFreshness(entry = {}, planningDateISO) {
  const date = String(entry.date || entry.logged_at || entry.created_at || entry.freshness || '').slice(0, 10);
  const daysAgo = daysBetweenISO(planningDateISO, date);
  if (daysAgo === null) return { daysAgo: null, label: entry.freshness || 'current' };
  if (daysAgo <= 0) return { daysAgo: 0, label: 'today' };
  if (daysAgo === 1) return { daysAgo, label: 'yesterday' };
  return { daysAgo, label: `${daysAgo} days ago` };
}

function injuryWithinWindow(injury, days) {
  return injury.daysAgo === null || injury.daysAgo <= days;
}

function bodyPartModalities(bodyPart) {
  const part = formatBodyPart(bodyPart);
  const lower = /\b(foot|feet|toe|ankle|achilles|calf|shin|knee|quad|hamstring|hip|groin|glute|it band|plantar|leg|lower back|back)\b/.test(part);
  const upper = /\b(shoulder|elbow|wrist|hand|forearm|bicep|tricep|chest|neck|upper back)\b/.test(part);
  const unknown = !lower && !upper;
  return {
    run: lower || unknown,
    lowerLift: lower || unknown,
    upperLift: upper || unknown,
  };
}

function normalizeInjuryEntries(injuryState = {}, planningDateISO) {
  const arrays = ['openInjuries', 'activeInjuries', 'injuries', 'logs', 'entries'];
  const source = arrays.find((key) => Array.isArray(injuryState[key]));
  const rows = source ? injuryState[source] : (injuryState.active || injuryState.hasActiveInjury ? [injuryState] : []);
  return rows.map((row) => {
    const cleared = row?.cleared === true || row?.cleared === 1 || String(row?.cleared) === '1';
    if (!row || cleared || row.active === false) return null;
    const freshness = injuryFreshness(row, planningDateISO);
    const severity = normalizeInjurySeverity(
      row.severity ?? row.injurySeverity ?? row.painSeverity ?? row.pain_level ?? row.painLevel
    );
    const bodyPart = formatBodyPart(row.bodyPart || row.body_part || row.area);
    return {
      id: row.id || null,
      bodyPart,
      severity,
      notes: row.notes || '',
      date: row.date || row.created_at || null,
      daysAgo: freshness.daysAgo,
      freshness: freshness.label,
      modalities: bodyPartModalities(bodyPart),
    };
  }).filter(Boolean);
}

function injuryRuleDetail(prefix, injury) {
  return `${prefix}: open ${injury.bodyPart} injury (${injury.severity || 'ungraded'}) logged ${injury.freshness}.`;
}

function buildInjuryEvidence(injuryState = {}, planningDateISO = null) {
  const sick = Boolean(injuryState && injuryState.sick);
  if (sick) {
    return {
      safety: true,
      reason: injuryState.reason || injuryState.notes || 'sick',
      rules: [],
      evidence: [{
        signal: 'sick',
        source: 'injury',
        objective: false,
        freshness: injuryState.freshness || 'current',
        detail: `User-logged sick: ${String(injuryState.reason || injuryState.notes || 'sick').slice(0, 180)}.`
      }],
    };
  }

  const entries = normalizeInjuryEntries(injuryState || {}, planningDateISO);
  const hasArraySource = ['openInjuries', 'activeInjuries', 'injuries', 'logs', 'entries'].some((key) => Array.isArray(injuryState?.[key]));
  const legacyActiveWithoutSeverity = Boolean(injuryState && (injuryState.active || injuryState.hasActiveInjury))
    && !hasArraySource
    && entries.length <= 1
    && !entries[0]?.severity;
  if (!entries.length && !legacyActiveWithoutSeverity) return { evidence: [], safety: false, reason: null, rules: [] };

  // Injury thresholds: open pain 5-7/moderate within 14 days trims affected
  // modality volume by 25% and caps intensity; open pain >=8/severe keeps the
  // existing safety-hold path. Legacy active injuries with no severity also
  // keep the existing safety behavior for compatibility.
  const severe = entries.find((entry) => entry.severity === 'severe');
  if (severe || legacyActiveWithoutSeverity) {
    const fallback = entries[0] || {};
    const reason = severe
      ? `open ${severe.bodyPart} injury (${severe.severity}) logged ${severe.freshness}`
      : injuryState.reason || injuryState.notes || `active injury${fallback.bodyPart ? ` (${fallback.bodyPart})` : ''}`;
    return {
      safety: true,
      reason,
      rules: [],
      evidence: [{
        signal: severe ? 'severe injury' : 'active injury',
        source: 'injury',
        objective: false,
        freshness: severe?.freshness || injuryState.freshness || 'current',
        detail: `User-logged ${reason}.`
      }],
    };
  }

  const rules = entries
    .filter((entry) => entry.severity === 'moderate' && injuryWithinWindow(entry, MODERATE_INJURY_WINDOW_DAYS))
    .map((entry) => ({
      action: 'reduce',
      volumeMultiplier: MODERATE_INJURY_VOLUME_MULTIPLIER,
      ...entry,
    }));
  const evidence = rules.map((rule) => ({
    signal: 'moderate injury',
    source: 'injury',
    objective: false,
    freshness: rule.freshness,
    detail: injuryRuleDetail('Reduced affected-modality load', rule),
  }));
  return {
    safety: false,
    reason: rules[0] ? injuryRuleDetail('Reduced affected-modality load', rules[0]) : null,
    rules,
    evidence,
  };
}

function patchRunForHeavyLegs(session) {
  if (!isHardRun(session)) return {};
  return {
    type: 'controlled',
    workout_type: 'run',
    title: 'Controlled aerobic run',
    intensity: 'Moderate',
    target_zone: 'Zone 2-3',
    pace_target: 'Controlled aerobic effort; skip hard surges',
    description: 'Intensity trimmed from today\'s heavy-leg check-in.',
    steps: ['Keep the effort controlled', 'Skip hard repeats or surges', 'Stop if soreness changes your stride'],
    progression: 'Do not add pace or extra reps today.',
    checkin_override: { action: 'keep', label: 'Intensity trimmed from heavy legs' },
  };
}

function recoveryRunDose(session = {}) {
  const duration = firstNumericSessionValue(session, ['duration_min', 'duration_minutes', 'minutes', 'time_minutes']);
  const distance = firstNumericSessionValue(session, ['distance_miles', 'distance', 'miles']);
  const basis = String(session.prescription_basis || '').toLowerCase();
  const minutes = duration ? Math.round(duration.value) : null;
  const miles = distance ? Math.round(distance.value * 10) / 10 : null;

  if (basis === 'time') {
    return {
      meaningful: minutes !== null && minutes >= MIN_EFFECTIVE_RECOVERY_RUN_MINUTES,
      decisionReason: minutes === null ? 'dose_unquantified' : 'below_time_minimum',
      basis,
      minutes,
      miles,
    };
  }
  if (basis === 'distance') {
    return {
      meaningful: miles !== null && miles >= MIN_EFFECTIVE_RECOVERY_RUN_MILES,
      decisionReason: miles === null ? 'dose_unquantified' : 'below_distance_minimum',
      basis,
      minutes,
      miles,
    };
  }
  if (minutes === null && miles === null) {
    return { meaningful: false, decisionReason: 'dose_unquantified', basis: 'unquantified', minutes, miles };
  }
  return {
    meaningful: (minutes !== null && minutes >= MIN_EFFECTIVE_RECOVERY_RUN_MINUTES)
      || (miles !== null && miles >= MIN_EFFECTIVE_RECOVERY_RUN_MILES),
    decisionReason: 'below_time_and_distance_minimums',
    basis: minutes !== null && miles !== null ? 'time_or_distance' : minutes !== null ? 'time' : 'distance',
    minutes,
    miles,
  };
}

function recoveryWalkOrRest(session, label, dose) {
  const safetyRationale = 'The reduced dose would not deliver the intended recovery session, so Forge does not label a token run as productive. Rest or comfortable low-strain movement is the truthful choice.';
  return {
    id: session.id,
    kind: 'rest',
    type: 'rest',
    workout_type: 'rest',
    title: 'Rest, easy walking, or mobility',
    intensity: 'Rest or very easy',
    target_zone: null,
    distance_miles: 0,
    prescription_basis: 'choice',
    description: `${label} ${safetyRationale}`,
    steps: [
      'Rest completely if you feel unusually tired, sore, unwell, or your movement is not normal',
      'Otherwise walk for 20-30 min at a very easy, fully conversational effort',
      'Or use 5-10 min of gentle mobility through comfortable ranges',
      'Stop the optional walking or mobility if pain increases, soreness changes normal movement, or you feel unwell',
    ],
    progression: 'Do not turn the recovery choice into a run workout or add intensity.',
    recovery_alternative: {
      policy: 'minimum_effective_recovery_session_v1',
      decision_reason: dose.decisionReason,
      evaluated_basis: dose.basis,
      minimum_run_minutes: MIN_EFFECTIVE_RECOVERY_RUN_MINUTES,
      minimum_run_miles: MIN_EFFECTIVE_RECOVERY_RUN_MILES,
      reduced_run_minutes: dose.minutes,
      reduced_run_miles: dose.miles,
      safety_rationale: safetyRationale,
      activity_health_minimum_claimed: false,
      options: [
        {
          type: 'rest',
          duration_minutes: 0,
          intensity: 'Rest / no exercise',
          guidance: 'Take a full rest day.',
          safety_rationale: 'Choose rest when unusually tired, sore, unwell, or normal movement is altered.',
        },
        {
          type: 'walking',
          duration_range_minutes: [20, 30],
          intensity: 'Very easy and fully conversational',
          guidance: 'Use relaxed walking only; this is not a run substitute to complete at pace.',
          safety_rationale: 'Continue only while movement feels comfortable; stop if pain or soreness changes normal movement.',
        },
        {
          type: 'mobility',
          duration_range_minutes: [5, 10],
          intensity: 'Gentle, comfortable range of motion',
          guidance: 'Choose familiar low-strain mobility and avoid loaded or forced ranges.',
          safety_rationale: 'Keep every movement pain-free and stop rather than pushing through discomfort.',
        },
      ],
    },
  };
}

function enforceMinimumEffectiveRecoveryRun(session, label, options = {}) {
  if (options.enforceStructuredRunFloor === false) return session;
  const dose = recoveryRunDose(session);
  return dose.meaningful ? session : recoveryWalkOrRest(session, label, dose);
}

function patchRunForRecovery(session, severity, label, options = {}) {
  const multiplier = severity === 'rest' ? 0.5 : 0.7;
  const next = Object.assign({}, session, {
    type: 'recovery',
    workout_type: 'recovery',
    title: severity === 'rest' ? 'Recovery run' : 'Easy aerobic run',
    intensity: severity === 'rest' ? 'Recovery' : 'Easy',
    target_zone: 'Zone 1-2',
    pace_target: 'Conversational effort',
    description: label,
    warmup: ['5-10 min easy walking or jogging'],
    steps: ['Stay in Zone 1-2', 'Keep breathing relaxed', 'Stop if soreness changes your stride'],
    cooldown: ['5 min easy walking', 'Hydrate and refuel'],
    progression: 'Do not add pace, repeats, or distance today.',
  });
  const miles = firstNumericSessionValue(session, ['distance_miles', 'distance', 'miles']);
  if (miles) next[miles.key] = Math.max(0.5, Math.round(miles.value * multiplier * 10) / 10);
  const duration = firstNumericSessionValue(session, ['duration_min', 'duration_minutes', 'minutes', 'time_minutes']);
  if (duration) next[duration.key] = Math.max(10, Math.round(duration.value * multiplier));
  if (session.injury_adjustment) {
    next.pace_target = session.pace_target;
    next.description = session.description;
    next.steps = clone(session.steps);
    next.cooldown = clone(session.cooldown);
    next.progression = session.progression;
  }
  return enforceMinimumEffectiveRecoveryRun(next, label, options);
}

function patchRunForReentry(session, index, distanceLimit = null, plannedMiles = null) {
  const next = patchRunForRecovery(
    session,
    'reduce',
    index === 0
      ? 'First easy run after a seven-day running gap.'
      : 'Easy re-entry running while consistency is rebuilt.',
    { enforceStructuredRunFloor: false },
  );
  next.title = index === 0 ? 'Return-to-running easy run' : 'Easy re-entry run';
  next.prescription_basis = 'time';
  const originalDuration = Number(session.duration_min);
  next.duration_min = Number.isFinite(originalDuration) && originalDuration > 0
    ? Math.min(originalDuration, index === 0 ? 30 : 45)
    : (index === 0 ? 25 : 30);
  const originalMiles = Number(session.distance_miles);
  if (Number.isFinite(originalMiles) && originalMiles > 0) {
    next.distance_miles = Number.isFinite(distanceLimit)
      ? Math.max(0, Math.min(originalMiles, distanceLimit))
      : originalMiles;
  }
  if (session.injury_adjustment) {
    next.title = 'Injury-adjusted re-entry run';
    next.pace_target = session.pace_target;
    next.description = session.description;
    next.steps = clone(session.steps);
    next.cooldown = clone(session.cooldown);
    next.progression = session.progression;
  }
  const finalMiles = Number(next.distance_miles);
  const actualMileageScale = Number.isFinite(plannedMiles) && plannedMiles > 0 && Number.isFinite(finalMiles)
    ? Math.round((finalMiles / plannedMiles) * 1000) / 1000
    : null;
  next.reentry_adjustment = {
    day: index + 1,
    intensity: 'easy',
    mileageScale: actualMileageScale,
  };
  return next;
}

function enforceRunGapConstraints(changeMap, constraint) {
  if (!constraint) return;
  const {
    plannedRuns,
    retainedRunCount,
    mileageScale,
    mileageCap,
  } = constraint;
  let remainingTenths = Math.max(0, Math.floor((mileageCap * 10) + 1e-9));

  plannedRuns.forEach((item, index) => {
    const key = `${item.date}:${item.sessionId}`;
    const current = changeMap.get(key)?.after || item.session;
    if (index >= retainedRunCount) {
      addChange(
        changeMap,
        item,
        safetyRestSession(item.session, 'the seven-day re-entry week is capped at three easy runs'),
        `${sessionSummary(item.session)} is removed from this re-entry week so the return stays capped at three easy runs.`
      );
      return;
    }
    if (String(current?.type || '').toLowerCase() === 'rest') return;

    const originalMiles = Number(item.session?.distance_miles);
    const desiredTenths = Number.isFinite(originalMiles) && originalMiles > 0
      ? Math.max(0, Math.floor((originalMiles * mileageScale * 10) + 1e-9))
      : 0;
    const allocatedTenths = Math.min(desiredTenths, remainingTenths);
    remainingTenths -= allocatedTenths;
    const after = patchRunForReentry(current, index, allocatedTenths / 10, originalMiles);
    addChange(
      changeMap,
      item,
      after,
      `${sessionSummary(item.session)} changes to ${sessionSummary(after)} for a bounded, nonpunitive return to running.`
    );
  });
}

function patchRunForInjury(session, rule) {
  const next = Object.assign({}, session, {
    type: 'recovery',
    workout_type: 'run',
    title: 'Injury-adjusted easy run',
    intensity: 'Easy',
    target_zone: 'Zone 1-2',
    pace_target: `Conversational effort; stop if ${rule.bodyPart} symptoms change your stride`,
    description: injuryRuleDetail('Reduced run volume', rule),
    warmup: ['5-10 min easy walking or jogging'],
    steps: ['Stay in Zone 1-2', `Stop if ${rule.bodyPart} pain increases`, 'Keep the stride relaxed and symmetrical'],
    cooldown: ['5 min easy walking', 'Hydrate and reassess symptoms'],
    progression: 'Hold pace, repeats, and distance progression until the injury log is cleared.',
    injury_adjustment: {
      action: rule.action,
      severity: rule.severity,
      body_part: rule.bodyPart,
      volume_multiplier: rule.volumeMultiplier,
    },
  });
  const miles = firstNumericSessionValue(session, ['distance_miles', 'distance', 'miles']);
  if (miles) next[miles.key] = Math.max(0.5, Math.round(miles.value * rule.volumeMultiplier * 10) / 10);
  const duration = firstNumericSessionValue(session, ['duration_min', 'duration_minutes', 'minutes', 'time_minutes']);
  if (duration) next[duration.key] = Math.max(10, Math.round(duration.value * rule.volumeMultiplier));
  return next;
}

function reducedInjuryExercise(name, bodyPart) {
  return {
    name,
    sets: 2,
    reps: '8-10',
    rest: '60 sec',
    load: 'Very light',
    rpe: '5-6',
    cue: `Stay pain-free around the ${bodyPart}.`,
    progression: 'No load progression today.',
  };
}

function reduceLiftExercisesForInjury(session, rule) {
  const source = Array.isArray(session.main) ? session.main : Array.isArray(session.exercises) ? session.exercises : [];
  if (!source.length) {
    return [
      reducedInjuryExercise('Pain-free range-of-motion strength', rule.bodyPart),
      reducedInjuryExercise('Light trunk stability drill', rule.bodyPart),
    ];
  }
  return source.map((exercise) => {
    const sets = Number(exercise.sets);
    return {
      ...exercise,
      sets: Number.isInteger(sets) ? Math.max(1, Math.floor(sets * rule.volumeMultiplier)) : exercise.sets,
      load: 'Light - about 25% below normal',
      rpe: '5-6',
      rir: '4+ RIR',
      cue: exercise.cue || `Stay pain-free around the ${rule.bodyPart}.`,
      progression: 'Hold load and volume today; resume progression after the injury log is cleared.',
    };
  });
}

function patchLiftForInjury(session, rule) {
  const exercises = reduceLiftExercisesForInjury(session, rule);
  const next = Object.assign({}, session, {
    kind: 'lift',
    type: 'strength',
    workout_type: 'strength',
    title: `Injury-adjusted ${session.title || 'strength session'}`,
    focus: session.focus || (rule.modalities.upperLift && !rule.modalities.lowerLift ? 'Upper body' : 'Lower body'),
    warmup: Array.isArray(session.warmup) && session.warmup.length
      ? session.warmup
      : ['5 min easy movement', 'Pain-free range-of-motion prep'],
    main: exercises,
    recovery: [
      `Stop if ${rule.bodyPart} pain increases`,
      'Resume normal strength loading only after symptoms settle',
    ],
    progression: 'Reduce volume by 25% today and avoid load progression.',
    description: injuryRuleDetail('Reduced strength volume', rule),
    injury_adjustment: {
      action: rule.action,
      severity: rule.severity,
      body_part: rule.bodyPart,
      volume_multiplier: rule.volumeMultiplier,
    },
  });
  if (Array.isArray(session.exercises) && !Array.isArray(session.main)) {
    delete next.main;
    next.exercises = exercises;
  }
  return next;
}

function liftAffectedByInjury(session = {}, rule = {}) {
  const focus = String(session.focus || session.title || '').toLowerCase();
  if (!focus) return rule.modalities.lowerLift || rule.modalities.upperLift;
  if (/lower/.test(focus)) return rule.modalities.lowerLift;
  if (/upper/.test(focus)) return rule.modalities.upperLift;
  return rule.modalities.lowerLift || rule.modalities.upperLift;
}

function safetyRestSession(session, reason) {
  return {
    id: session.id,
    kind: 'rest',
    type: 'rest',
    workout_type: 'rest',
    title: 'Safety hold',
    intensity: 'Rest',
    target_zone: null,
    distance_miles: 0,
    description: `Safety hold: ${reason}`,
    steps: [],
  };
}

function replaceLowerBodyAfterRun(session, latestRun) {
  return {
    ...session,
    kind: 'lift',
    type: 'strength',
    workout_type: 'strength',
    title: 'Optional upper-body strength',
    focus: 'Upper body',
    warmup: ['Band pull-apart x 20', 'Scapular push-up x 10', 'Two progressive warm-up sets'],
    main: [
      { name: 'Dumbbell bench press', sets: 3, reps: '6-8', rest: '2 min', load: 'Submaximal', rpe: '6-7', cue: 'Keep the shoulder blades set on the bench.', progression: 'Hold load today; do not chase fatigue.' },
      { name: 'One-arm dumbbell row', sets: 3, reps: '8 each side', rest: '90 sec', load: 'Moderate', rpe: '6-7', cue: 'Drive the elbow toward the hip without twisting.', progression: 'Stop with at least three reps in reserve.' },
      { name: 'Pull-up or lat pulldown', sets: 2, reps: '6-10', rest: '90 sec', load: 'Easy-moderate', rir: '3', cue: 'Pull the elbows down without shrugging.', progression: 'Skip the final set if whole-body fatigue is elevated.' },
    ],
    recovery: ['Skip this optional session if soreness changes normal movement', 'Prioritize carbohydrate, protein, hydration, and sleep'],
    progression: 'Resume normal strength progression after lower-body recovery is normal.',
    description: `Lower-body loading is deferred after the ${Number(latestRun.distanceMiles || 0).toFixed(1)} mi recent run.`,
    acuteLoadAdjusted: true,
  };
}

function markUpperBodyOptionalAfterRun(session, latestRun) {
  const currentTitle = String(session.title || 'Upper-body strength').replace(/^Optional\s+/i, '');
  return {
    ...session,
    title: `Optional ${currentTitle}`,
    description: `${session.description || 'Upper-body strength.'} Keep this submaximal and skip it if whole-body fatigue or soreness is elevated after the ${Number(latestRun.distanceMiles || 0).toFixed(1)} mi run.`,
    acuteLoadAdjusted: true,
  };
}

function addChange(changeMap, item, after, summary) {
  const key = `${item.date}:${item.sessionId}`;
  if (deepEqual(item.session, after)) return;
  changeMap.set(key, {
    date: item.date,
    sessionId: item.sessionId,
    kind: planSchema.kindFromSession(item.session),
    before: clone(item.session),
    after: clone(after),
    summary,
  });
}

function applyChangesToClone(plan, changes) {
  const next = clone(plan);
  const byDate = new Map();
  for (const change of changes || []) {
    if (!change || !change.date || !change.sessionId) continue;
    const list = byDate.get(change.date) || [];
    list.push(change);
    byDate.set(change.date, list);
  }

  const weeks = Array.isArray(next.weeks) ? next.weeks : [];
  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    const week = weeks[weekIndex] || {};
    const entries = planSchema.getDayEntries(week);
    const key = planSchema.dayEntriesKey(week);
    let touched = false;
    const nextEntries = entries.map((day, dayIndex) => {
      const dayChanges = byDate.get(day && day.date);
      if (!dayChanges || !dayChanges.length) return day;
      touched = true;
      const changeBySessionId = new Map(dayChanges.map((change) => [String(change.sessionId), change]));

      if (Array.isArray(day && day.sessions)) {
        const rebuilt = [];
        day.sessions.forEach((session, sessionIndex) => {
          const id = sessionIdFor(day, session, sessionIndex, dayIndex);
          const change = changeBySessionId.get(String(id));
          if (!change) {
            rebuilt.push(session);
            return;
          }
          const afterKind = planSchema.kindFromSession(change.after);
          if (change.after?.removeSession === true) return;
          // A normal rest conversion removes the executable session. The
          // recovery-floor policy is different: it is a real, reviewable
          // rest/easy-walk prescription that must survive acceptance so the
          // calendar can explain the alternative instead of silently showing
          // an empty day.
          if (afterKind === 'rest' && !change.after?.recovery_alternative) return;
          rebuilt.push(Object.assign({}, change.after, { id: change.after.id || session.id || id }));
        });
        const framed = planSchema.toCanonicalDay(day, rebuilt, true);
        framed.sessions = rebuilt.map((session, sessionIndex) => (
          Object.assign({}, session, { id: session.id || `${day.date || day.day || 'day'}-${sessionIndex}` })
        ));
        return framed;
      }

      const legacyId = sessionIdFor(day, day, 0, dayIndex);
      const change = changeBySessionId.get(String(legacyId));
      if (!change) return day;
      return planSchema.applyOverrideToDay(day, change.after || {});
    });
    if (touched) weeks[weekIndex] = Object.assign({}, week, { [key]: nextEntries });
  }
  return next;
}

function invariantSignature(plan) {
  const goal = plan && plan.goal ? plan.goal : {};
  const goalSignature = (entry = {}) => ({
    kind: entry.kind,
    raceId: entry.raceId,
    name: entry.name,
    date: entry.date,
    distanceMiles: entry.distanceMiles,
    goalType: entry.goalType,
    goalTimeSeconds: entry.goalTimeSeconds,
    goalPaceSecondsPerMile: entry.goalPaceSecondsPerMile,
    priority: entry.priority,
    sequence: entry.sequence,
    role: entry.role,
    course: entry.course === undefined ? null : entry.course,
  });
  const raceSessions = [];
  iterateDays(plan, ({ day }) => {
    for (const session of Array.isArray(day?.sessions) ? day.sessions : []) {
      if (String(session?.type || '').toLowerCase() !== 'race') continue;
      raceSessions.push({ date: day.date, session: clone(session) });
    }
  });
  return {
    schemaVersion: plan && plan.schemaVersion,
    planMode: plan && plan.planMode,
    strengthPolicy: plan && plan.strengthPolicy,
    goal: goalSignature(goal),
    goals: (Array.isArray(plan && plan.goals) ? plan.goals : []).map(goalSignature),
    phases: (Array.isArray(plan && plan.weeks) ? plan.weeks : []).map((week) => ({
      week: week && week.week,
      phase: week && week.phase,
    })),
    raceSessions,
  };
}

function outsideWindowDaysEqual(original, candidate, start, end, safetyException) {
  if (safetyException) return true;
  const snapshot = (plan) => {
    const days = [];
    iterateDays(plan, ({ weekIndex, dayIndex, day }) => {
      if (!day || !day.date || isWithin(day.date, start, end)) return;
      days.push({ weekIndex, dayIndex, day });
    });
    return days;
  };
  return deepEqual(snapshot(original), snapshot(candidate));
}

function strengthFloorPreserved(plan) {
  if (!planSchema.isHybridMode(plan && plan.planMode)) return true;
  const floor = Number(plan && plan.strengthPolicy && plan.strengthPolicy.minimumSessionsPerWeek);
  if (!Number.isFinite(floor) || floor <= 0) return true;
  const weeks = Array.isArray(plan.weeks) ? plan.weeks : [];
  return weeks.every((week) => {
    if (week && week.phase === 'race') return true;
    const liftCount = planSchema.getDayEntries(week)
      .flatMap((day) => planSchema.daySessions(day))
      .filter((session) => planSchema.kindFromSession(session) === 'lift')
      .length;
    return liftCount >= floor;
  });
}

function keepProposal(input, planningDate, windowStart, windowEnd, evidence, headline, reason) {
  return {
    status: 'keep',
    planningDate,
    windowStart,
    windowEnd,
    safetyException: false,
    evidence: evidence || [],
    changes: [],
    headline,
    choices: ['accept', 'keep_original'],
    reason,
    planVersion: input && input.planVersion ? input.planVersion : null,
    proposedPlan: clone(input && input.plan),
  };
}

function validateCandidateOrKeep(input, proposal, candidate, allowedWindowEnd) {
  const plan = input.plan;
  const planningDate = proposal.planningDate;
  if (!deepEqual(invariantSignature(plan), invariantSignature(candidate))) {
    return keepProposal(
      input,
      planningDate,
      proposal.windowStart,
      allowedWindowEnd,
      proposal.evidence,
      'Keep the calendar as planned',
      'A candidate adjustment attempted to change protected race, course, phase, mode, or strength-policy metadata, so it was rejected.'
    );
  }
  if (!outsideWindowDaysEqual(plan, candidate, proposal.windowStart, allowedWindowEnd, proposal.safetyException)) {
    return keepProposal(
      input,
      planningDate,
      proposal.windowStart,
      allowedWindowEnd,
      proposal.evidence,
      'Keep the calendar as planned',
      `A candidate adjustment changed sessions outside the allowed window ending ${allowedWindowEnd}, so it was rejected.`
    );
  }
  if (!proposal.safetyException && !strengthFloorPreserved(candidate)) {
    return keepProposal(
      input,
      planningDate,
      proposal.windowStart,
      allowedWindowEnd,
      proposal.evidence,
      'Keep the calendar as planned',
      'A candidate adjustment would drop lifting below the protected weekly strength floor, so it was rejected.'
    );
  }
  return Object.assign({}, proposal, { proposedPlan: candidate });
}

function buildAdaptationProposal(input = {}) {
  const plan = input.plan;
  const planningDate = input.planningDateISO || input.planningDate;
  const parsedPlanningDate = parseISODate(planningDate);
  if (!planSchema.isSchemaV2(plan) || !parsedPlanningDate) {
    return keepProposal(
      input,
      planningDate || null,
      planningDate || null,
      planningDate || null,
      [],
      'Keep the calendar as planned',
      'This plan is not a dated schema-v2 calendar, so no transparent adaptation was computed.'
    );
  }

  const normalWindowEnd = addDays(planningDate, 3);
  const windowStart = planningDate;
  const todaySessions = allDatedSessions(plan, planningDate, planningDate);
  const injury = buildInjuryEvidence(input.injuryState || input.injury || {}, planningDate);
  const checkin = buildCheckinEvidence(input.checkin || {}, todaySessions);
  const health = buildHealthEvidence(input.healthSignals || {});
  const completion = buildCompletionEvidence(input.completion || input.adherence || {});
  const recentRun = buildRecentRunEvidence(input.recentRunLoad || {});
  let safetyException = false;
  let safetyReason = null;
  let windowEnd = normalWindowEnd;
  const evidence = [
    ...injury.evidence,
    ...checkin.evidence.filter((item) => {
      if (checkin.action === 'keep' && !checkin.safety && !checkin.includeWhenKeep) return false;
      return true;
    }),
    ...health.evidence,
    ...completion.evidence,
    ...recentRun.evidence,
  ];

  if (injury.safety || checkin.safety) {
    safetyException = true;
    safetyReason = injury.reason || 'sick or injured check-in';
    windowEnd = addDays(planningDate, 6);
  } else if (completion.runGap) {
    windowEnd = addDays(planningDate, 6);
  }

  if (input.candidatePlan) {
    const candidateProposal = {
      status: 'proposal',
      planningDate,
      windowStart,
      windowEnd: normalWindowEnd,
      safetyException: false,
      evidence,
      changes: [],
      headline: 'Candidate adjustment rejected if invariants changed',
      choices: ['accept', 'keep_original'],
      reason: 'Candidate plan supplied for validation.',
      planVersion: input.planVersion || null,
    };
    return validateCandidateOrKeep(input, candidateProposal, clone(input.candidatePlan), normalWindowEnd);
  }

  const changes = new Map();
  let runGapConstraint = null;
  const sessionsInWindow = allDatedSessions(plan, windowStart, windowEnd);

  if (safetyException) {
    for (const item of sessionsInWindow) {
      if (item.kind !== 'run' && item.kind !== 'lift') continue;
      if (String(item.session?.type || '').toLowerCase() === 'race') continue;
      addChange(
        changes,
        item,
        safetyRestSession(item.session, safetyReason),
        `Safety hold replaces ${sessionSummary(item.session)} because ${safetyReason}.`
      );
    }
  } else {
    const todayRun = todaySessions.find((item) => item.kind === 'run');
    if (todayRun && checkin.action !== 'keep' && Object.keys(checkin.patch || {}).length) {
      const patched = planSchema.applyOverrideToDay(todayRun.session, checkin.patch);
      const after = checkin.action === 'recovery_swap'
        ? enforceMinimumEffectiveRecoveryRun(patched, 'Recovery choice from today\'s soreness or fatigue check-in.')
        : patched;
      addChange(
        changes,
        todayRun,
        after,
        `${sessionSummary(todayRun.session)} changes to ${sessionSummary(after)} from today's subjective check-in.`
      );
    } else if (todayRun && checkin.action === 'keep' && Object.keys(checkin.patch || {}).length) {
      const after = planSchema.applyOverrideToDay(todayRun.session, checkin.patch);
      addChange(
        changes,
        todayRun,
        after,
        `${sessionSummary(todayRun.session)} stays on the calendar but intensity is capped from today's subjective check-in.`
      );
    }

    if (health.severity !== 'none') {
      for (const item of sessionsInWindow) {
        if (item.kind !== 'run' || String(item.session?.type || '').toLowerCase() === 'race' || !isHardRun(item.session)) continue;
        const after = patchRunForRecovery(
          item.session,
          health.severity,
          health.severity === 'rest'
            ? 'Recovery version from fresh objective Apple Health recovery signals.'
            : 'Easier version from fresh objective Apple Health recovery signals.'
        );
        addChange(
          changes,
          item,
          after,
          `${sessionSummary(item.session)} changes to ${sessionSummary(after)} from fresh objective Apple Health recovery data.`
        );
      }
    }

    if (completion.runGap) {
      const plannedRuns = sessionsInWindow.filter((item) => (
        item.kind === 'run' && String(item.session?.type || '').toLowerCase() !== 'race'
      ));
      const baselineMiles = Number(completion.weeklyMileageBaseline || 0);
      const originalMiles = plannedRuns.reduce((sum, item) => {
        const miles = Number(item.session?.distance_miles);
        return sum + (Number.isFinite(miles) && miles > 0 ? miles : 0);
      }, 0);
      const mileageCap = baselineMiles > 0
        ? Math.min(originalMiles * 0.8, baselineMiles * 0.7)
        : Math.min(originalMiles > 0 ? originalMiles * 0.8 : 9, 9);
      const mileageScale = originalMiles > 0
        ? Math.min(1, Math.max(0, mileageCap / originalMiles))
        : 0.7;
      runGapConstraint = {
        plannedRuns,
        retainedRunCount: baselineMiles > 0 ? plannedRuns.length : Math.min(plannedRuns.length, 3),
        mileageScale,
        mileageCap,
      };
    } else if (completion.driver) {
      const nextHard = sessionsInWindow.find((item) => (
        item.kind === 'run'
        && String(item.session?.type || '').toLowerCase() !== 'race'
        && isHardRun(item.session)
      ));
      if (nextHard) {
        const after = patchRunForRecovery(
          nextHard.session,
          'reduce',
          'Easier version from recent completion and missed-session history.'
        );
        addChange(
          changes,
          nextHard,
          after,
          `${sessionSummary(nextHard.session)} changes to ${sessionSummary(after)} from recent completion history.`
        );
      }
    }

    if (Array.isArray(injury.rules) && injury.rules.length) {
      for (const rule of injury.rules) {
        for (const item of sessionsInWindow) {
          const key = `${item.date}:${item.sessionId}`;
          const current = changes.get(key)?.after || item.session;
          if (item.kind === 'run' && rule.modalities.run && String(item.session.type || '').toLowerCase() !== 'race') {
            const adjusted = patchRunForInjury(current, rule);
            const after = enforceMinimumEffectiveRecoveryRun(
              adjusted,
              `Lower-strain choice because ${injuryRuleDetail('the reduced run', rule)}`
            );
            addChange(
              changes,
              item,
              after,
              `${sessionSummary(item.session)} changes to ${sessionSummary(after)} because ${injuryRuleDetail('reduced run volume', rule)}`
            );
            continue;
          }
          if (item.kind === 'lift' && liftAffectedByInjury(current, rule)) {
            const after = patchLiftForInjury(current, rule);
            addChange(
              changes,
              item,
              after,
              `${sessionSummary(item.session)} changes to ${sessionSummary(after)} because ${injuryRuleDetail('reduced strength volume', rule)}`
            );
          }
        }
      }
    }

    if (recentRun.driver) {
      for (const item of sessionsInWindow) {
        const key = `${item.date}:${item.sessionId}`;
        const current = changes.get(key)?.after || item.session;
        if (item.kind === 'run' && recentRun.protection.noAdditionalRunOnDate === item.date && String(item.session.type || '').toLowerCase() !== 'race') {
          addChange(
            changes,
            item,
            safetyRestSession(current, 'a run is already logged for today'),
            `${sessionSummary(item.session)} is removed because the ${Number(recentRun.latest.distanceMiles || 0).toFixed(1)} mi run is already logged today.`
          );
          continue;
        }
        if (item.kind === 'run' && recentRun.protection.postRunSevere && item.date <= recentRun.protection.hardRunsThrough && String(item.session.type || '').toLowerCase() !== 'race') {
          addChange(
            changes,
            item,
            safetyRestSession(current, 'severe pain was reported after the recent run'),
            `${sessionSummary(item.session)} is held because severe post-run pain protects running through ${recentRun.protection.hardRunsThrough}.`
          );
          continue;
        }
        if (item.kind === 'run' && isDemandingRun(item.session) && item.date <= recentRun.protection.hardRunsThrough && String(item.session.type || '').toLowerCase() !== 'race') {
          const after = patchRunForRecovery(
            current,
            'reduce',
            `Recovery version after the ${Number(recentRun.latest.distanceMiles || 0).toFixed(1)} mi recent run.`
          );
          addChange(
            changes,
            item,
            after,
            `${sessionSummary(item.session)} changes to ${sessionSummary(after)} because hard running is protected through ${recentRun.protection.hardRunsThrough}.`
          );
          continue;
        }
        if (item.kind === 'lift' && /lower/i.test(String(current.focus || '')) && item.date <= recentRun.protection.lowerBodyThrough) {
          const after = replaceLowerBodyAfterRun(current, recentRun.latest);
          addChange(
            changes,
            item,
            after,
            `${sessionSummary(item.session)} changes to optional upper-body strength because lower-body loading is protected through ${recentRun.protection.lowerBodyThrough}.`
          );
          continue;
        }
        if (item.kind === 'lift' && /upper/i.test(String(current.focus || '')) && item.date <= recentRun.protection.upperBodyOptionalThrough) {
          const after = markUpperBodyOptionalAfterRun(current, recentRun.latest);
          addChange(
            changes,
            item,
            after,
            `${sessionSummary(item.session)} remains upper-body only and becomes optional after the recent run.`
          );
        }
      }
    }

  }

  enforceRunGapConstraints(changes, runGapConstraint);

  const changeList = Array.from(changes.values()).sort((a, b) => (
    compareISO(a.date, b.date) || String(a.sessionId).localeCompare(String(b.sessionId))
  ));

  if (!changeList.length) {
    return keepProposal(
      input,
      planningDate,
      windowStart,
      windowEnd,
      evidence,
      'Keep the calendar as planned',
      evidence.length
        ? 'Available signals do not warrant changing the dated race calendar.'
        : 'No fresh objective Apple Health driver, recent-run load, subjective check-in driver, completion concern, or active injury was provided.'
    );
  }

  const candidate = applyChangesToClone(plan, changeList);
  const proposal = {
    status: 'proposal',
    planningDate,
    windowStart,
    windowEnd,
    safetyException,
    evidence,
    changes: changeList,
    headline: safetyException
      ? 'Safety hold for the live calendar'
      : completion.runGap ? 'Ready to ease back into running?' : 'Small transparent calendar adjustment',
    choices: ['accept', 'keep_original'],
    reason: safetyException
      ? `A safety exception is marked because ${safetyReason}; the hold can extend beyond 72 hours.`
      : completion.runGap
        ? `We have not seen a logged run in ${completion.daysSinceRun} days. Lifting still counts; this optional change only eases the next seven days of running, and you can leave the calendar exactly as it is.`
        : 'Only dated sessions inside the next 72 hours are changed from current recovery, recent-run load, check-in, and completion evidence; race target, phases, course facts, and the strength policy stay fixed.',
    planVersion: input.planVersion || null,
  };
  return validateCandidateOrKeep(input, proposal, candidate, windowEnd);
}

function applyProposalToPlan(plan, proposal = {}) {
  if (!proposal || !Array.isArray(proposal.changes) || proposal.changes.length === 0) return clone(plan);
  return applyChangesToClone(plan, proposal.changes);
}

function proposalMatchesPlanVersion(proposal = {}, planVersion) {
  if (!proposal.planVersion) return true;
  return String(proposal.planVersion) === String(planVersion);
}

module.exports = {
  parseISODate,
  toISODate,
  addDays,
  buildAdaptationProposal,
  applyProposalToPlan,
  proposalMatchesPlanVersion,
  isHardRun,
};
