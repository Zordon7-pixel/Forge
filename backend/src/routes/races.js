const router = require('express').Router();
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { dbGet, dbAll, withPlanningInputMutation } = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const raceCourse = require('../lib/raceCourse');
const { advancePlanningMutationRevisions, planningInputUnchanged } = require('../lib/planningRevision');
const { goalBackwardApplyEnvelopeFromRequest } = require('../lib/planCandidateLifecycle');
const { canonicalStringify } = require('../lib/racePlanPolicy');
const hyroxStandards = require('../lib/hyroxStandards');
const { isIanaTimezone } = require('../lib/hyroxPlan');
const plansRouter = require('./plans');

const PLAN_RESET_CONFIRMATION = 'CLEAR_ACTIVE_PLAN_AND_REMOVE_RACE';

// GPX uploads are held in memory only; raw coordinates are never persisted.
const gpxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: raceCourse.GPX_MAX_BYTES, files: 1 },
});
const RACE_STATUSES = new Set(['upcoming', 'completed', 'cancelled']);
const EVENT_STATES = new Set(['SCHEDULED', 'COMPLETED', 'DNS', 'CANCELLED', 'POSTPONED', 'UNKNOWN']);
const HYROX_TRAINING_DAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
const gpxUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => String(req.user.id),
  message: { error: 'Too many GPX uploads. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function cleanString(value, maxLen = 200) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, maxLen);
}

function isValidISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
  const normalized = value.trim();
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized;
}

function parseGoalTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 0 && seconds <= 30 * 24 * 60 * 60 ? seconds : NaN;
}

function parseEventConfig(value) {
  if (value === null || value === undefined || value === '') return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (error) {
      return null;
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function lifecycleError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

function legacyStatusForEventState(eventState) {
  if (eventState === 'COMPLETED' || eventState === 'DNS') return 'completed';
  if (eventState === 'CANCELLED') return 'cancelled';
  return 'upcoming';
}

function eventStateForLegacyStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'completed') return 'COMPLETED';
  if (normalized === 'cancelled') return 'CANCELLED';
  if (normalized === 'upcoming') return 'SCHEDULED';
  return 'UNKNOWN';
}

function normalizeEventState(value, fallback = 'UNKNOWN') {
  const normalized = String(value || fallback).trim().toUpperCase();
  return EVENT_STATES.has(normalized) ? normalized : null;
}

function readRaceEventLifecycle(race = {}) {
  const config = parseEventConfig(race.event_config_json) || {};
  const lifecycle = config.goal_backward_lifecycle && typeof config.goal_backward_lifecycle === 'object'
    && !Array.isArray(config.goal_backward_lifecycle) ? config.goal_backward_lifecycle : {};
  const eventState = normalizeEventState(
    race.event_state ?? lifecycle.event_state,
    eventStateForLegacyStatus(race.status),
  ) || 'UNKNOWN';
  return Object.freeze({
    event_state: eventState,
    event_revision: Math.max(1, Number(race.event_revision ?? lifecycle.event_revision ?? 1)),
    goal_revision: Math.max(1, Number(race.goal_revision ?? lifecycle.goal_revision ?? race.revision ?? 1)),
    transition_exit_met: race.transition_exit_met === true || lifecycle.transition_exit_met === true,
    race_result: lifecycle.race_result && typeof lifecycle.race_result === 'object'
      ? lifecycle.race_result : null,
  });
}

function normalizedRaceResult(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw lifecycleError('RACE_RESULT_INVALID', 'race_result must be a structured object');
  }
  const finishTime = value.finish_time_s ?? value.finishTimeSeconds;
  const placement = value.placement;
  const result = {
    finish_time_s: finishTime === null || finishTime === undefined ? null : Number(finishTime),
    placement: placement === null || placement === undefined ? null : Number(placement),
    result_code: cleanString(value.result_code ?? value.resultCode, 40).toUpperCase() || null,
  };
  if (result.finish_time_s !== null && (!Number.isInteger(result.finish_time_s) || result.finish_time_s < 0
    || result.finish_time_s > 30 * 24 * 60 * 60)) {
    throw lifecycleError('RACE_RESULT_INVALID', 'race_result finish_time_s is invalid');
  }
  if (result.placement !== null && (!Number.isInteger(result.placement) || result.placement < 1)) {
    throw lifecycleError('RACE_RESULT_INVALID', 'race_result placement is invalid');
  }
  return result;
}

function scalarRacePatchChanged(race, patch) {
  const comparisons = [
    ['race_name', (value) => cleanString(value, 200)],
    ['distance_miles', (value) => Number(value)],
    ['location', (value) => cleanString(value, 200) || null],
    ['goal_time_seconds', (value) => parseGoalTime(value)],
    ['notes', (value) => cleanString(value, 2000) || null],
    ['event_kind', (value) => cleanString(value, 20).toLowerCase()],
    ['event_format', (value) => cleanString(value, 30).toLowerCase() || null],
    ['event_category', (value) => cleanString(value, 30).toLowerCase() || null],
    ['event_timezone', (value) => cleanString(value, 100) || null],
    ['rules_version', (value) => cleanString(value, 30) || null],
  ];
  return comparisons.some(([key, normalize]) => (
    Object.prototype.hasOwnProperty.call(patch, key)
    && JSON.stringify(normalize(patch[key])) !== JSON.stringify(normalize(race[key]))
  ));
}

function transitionRaceEventLifecycle(race = {}, patch = {}) {
  const current = readRaceEventLifecycle(race);
  const currentConfig = parseEventConfig(race.event_config_json) || {};
  let config = currentConfig;
  let eventConfigChanged = false;
  if (Object.prototype.hasOwnProperty.call(patch, 'event_config_json')) {
    config = parseEventConfig(patch.event_config_json);
    if (!config) throw lifecycleError('EVENT_CONFIG_INVALID', 'event_config_json is invalid');
    eventConfigChanged = canonicalStringify(config) !== canonicalStringify(currentConfig);
  }
  const hasExplicitState = patch.event_state !== undefined || patch.eventState !== undefined;
  const hasLegacyStatus = Boolean(patch.status);
  const legacyStatus = cleanString(patch.status, 20).toLowerCase();
  if (hasLegacyStatus && !RACE_STATUSES.has(legacyStatus)) {
    throw lifecycleError('EVENT_STATE_INVALID', 'status is invalid');
  }
  const desiredFromStatus = hasLegacyStatus ? eventStateForLegacyStatus(patch.status) : current.event_state;
  const eventState = normalizeEventState(
    patch.event_state ?? patch.eventState,
    hasExplicitState ? null : desiredFromStatus,
  );
  if (!eventState) throw lifecycleError('EVENT_STATE_INVALID', 'event_state is invalid');
  if (current.event_state === 'COMPLETED' && eventState !== 'COMPLETED') {
    throw lifecycleError('EVENT_STATE_TRANSITION_INVALID', 'A completed event cannot be returned to a future state');
  }
  if (current.event_state === 'DNS' && eventState !== 'DNS') {
    throw lifecycleError('EVENT_STATE_TRANSITION_INVALID', 'A DNS event cannot be returned to a future state');
  }

  const currentDate = String(race.event_local_date || race.race_date || '').slice(0, 10);
  const requestedDate = String(patch.event_local_date ?? patch.race_date ?? currentDate).slice(0, 10);
  if (!isValidISODate(requestedDate)) {
    throw lifecycleError('INVALID_RACE_DATE', 'event_local_date must be YYYY-MM-DD');
  }
  if (eventState === 'POSTPONED' && requestedDate === currentDate && current.event_state !== 'POSTPONED') {
    throw lifecycleError('POSTPONED_DATE_REQUIRED', 'A postponed event requires a new local date');
  }
  const requestedExit = patch.transition_exit_met === undefined && patch.transitionExitMet === undefined
    ? current.transition_exit_met
    : patch.transition_exit_met === true || patch.transitionExitMet === true;
  if (requestedExit && eventState !== 'COMPLETED') {
    throw lifecycleError('POST_RACE_EXIT_INVALID', 'Post-race transition can exit only after completion');
  }
  const raceResult = patch.race_result === undefined && patch.raceResult === undefined
    ? current.race_result : normalizedRaceResult(patch.race_result ?? patch.raceResult);
  const resultChanged = JSON.stringify(raceResult) !== JSON.stringify(current.race_result);
  const changed = eventState !== current.event_state
    || requestedDate !== currentDate
    || requestedExit !== current.transition_exit_met
    || resultChanged
    || eventConfigChanged
    || scalarRacePatchChanged(race, patch);
  const eventRevision = current.event_revision + (changed ? 1 : 0);
  const revisionState = advancePlanningMutationRevisions({
    planning_input_revision: 0,
    goal_revision: current.goal_revision,
    athlete_state_revision: 1,
    lock_revision: 0,
    edit_revision: 0,
  }, { event: changed });
  const goalRevision = revisionState.goal_revision;
  const eventConfig = {
    ...config,
    goal_backward_lifecycle: {
      event_state: eventState,
      event_revision: eventRevision,
      goal_revision: goalRevision,
      transition_exit_met: requestedExit,
      race_result: raceResult,
    },
  };
  return Object.freeze({
    event_state: eventState,
    event_revision: eventRevision,
    goal_revision: goalRevision,
    transition_exit_met: requestedExit,
    race_result: raceResult,
    event_local_date: requestedDate,
    race_date: requestedDate,
    status: legacyStatusForEventState(eventState),
    event_config_json: JSON.stringify(eventConfig),
    changed,
  });
}

function normalizeRaceEvent(body = {}) {
  const raceName = cleanString(body.race_name, 200);
  const eventKind = cleanString(body.event_kind || 'run_race', 20).toLowerCase();
  const localDate = cleanString(body.event_local_date || body.race_date, 10);
  const timezone = cleanString(body.event_timezone, 100) || null;
  const hasLegacyStatus = Boolean(body.status);
  const legacyStatus = cleanString(body.status, 20).toLowerCase();
  if (hasLegacyStatus && !RACE_STATUSES.has(legacyStatus)) {
    return { valid: false, error: 'status is invalid' };
  }
  const explicitEventState = normalizeEventState(body.event_state ?? body.eventState,
    eventStateForLegacyStatus(body.status || 'upcoming'));
  const status = legacyStatusForEventState(explicitEventState || 'UNKNOWN');
  const goalTimeSeconds = parseGoalTime(body.goal_time_seconds);
  if (!raceName) return { valid: false, error: 'race_name is required' };
  if (!['run_race', 'hyrox'].includes(eventKind)) return { valid: false, error: 'event_kind is invalid' };
  if (!isValidISODate(localDate)) return { valid: false, error: 'event_local_date must be YYYY-MM-DD' };
  if (timezone && !isIanaTimezone(timezone)) return { valid: false, error: 'event_timezone must be a valid IANA timezone' };
  if (!explicitEventState || !RACE_STATUSES.has(status)) return { valid: false, error: 'event_state or status is invalid' };
  if (Number.isNaN(goalTimeSeconds)) return { valid: false, error: 'goal_time_seconds is invalid' };
  const config = parseEventConfig(body.event_config_json);
  if (!config) return { valid: false, error: 'event_config_json is invalid' };

  let eventFormat = null;
  let eventCategory = null;
  let rulesVersion = null;
  let distanceMiles = Number(body.distance_miles);
  if (eventKind === 'hyrox') {
    if (!timezone) return { valid: false, error: 'event_timezone is required for HYROX' };
    eventFormat = hyroxStandards.normalizeHyroxFormat(body.event_format);
    eventCategory = hyroxStandards.normalizeHyroxCategory(body.event_category);
    rulesVersion = cleanString(body.rules_version, 30);
    if (!eventFormat) return { valid: false, error: 'event_format is required for HYROX' };
    if (!eventCategory) return { valid: false, error: 'event_category is required for HYROX' };
    const standard = hyroxStandards.resolveHyroxStandard({ format: eventFormat, category: eventCategory, rulesVersion });
    if (standard.status !== 'exact') return { valid: false, error: `HYROX standards are unavailable: ${standard.status}` };
    // Relay records describe this athlete's two 1 km legs, not the team's
    // full eight-leg course. Individual and Doubles athletes run all eight.
    distanceMiles = hyroxStandards.hyroxAthleteRunDistanceMiles(eventFormat);
  } else if (!Number.isFinite(distanceMiles) || distanceMiles <= 0 || distanceMiles > 100) {
    return { valid: false, error: 'distance_miles must be between 0 and 100' };
  }
  const equipment = hyroxStandards.normalizeEquipment(config.equipment);
  const runningPriority = ['maintain', 'improve', 'race_pr'].includes(config.runningPriority)
    ? config.runningPriority : 'maintain';
  const lifecycle = readRaceEventLifecycle({ ...body, status, event_state: explicitEventState, event_config_json: config });
  const persistLifecycle = Boolean(config.goal_backward_lifecycle)
    || Object.prototype.hasOwnProperty.call(body, 'event_state')
    || Object.prototype.hasOwnProperty.call(body, 'eventState')
    || Object.prototype.hasOwnProperty.call(body, 'event_revision')
    || Object.prototype.hasOwnProperty.call(body, 'goal_revision')
    || Object.prototype.hasOwnProperty.call(body, 'transition_exit_met');
  const eventConfig = {
    schemaVersion: 1,
    equipment,
    runningPriority,
    ...(config.hyroxEventState ? { hyroxEventState: config.hyroxEventState } : {}),
    ...(config.hyrox_event_state ? { hyrox_event_state: config.hyrox_event_state } : {}),
    ...(config.hyroxPerformanceBudget ? { hyroxPerformanceBudget: config.hyroxPerformanceBudget } : {}),
    ...(config.goal_backward_lifecycle ? { goal_backward_lifecycle: config.goal_backward_lifecycle } : persistLifecycle ? {
      goal_backward_lifecycle: {
        event_state: explicitEventState,
        event_revision: lifecycle.event_revision,
        goal_revision: lifecycle.goal_revision,
        transition_exit_met: lifecycle.transition_exit_met,
        race_result: lifecycle.race_result,
      },
    } : {}),
  };
  if (eventKind === 'hyrox' && (config.runDaysPerWeek !== undefined || config.trainingDays !== undefined)) {
    const runDaysPerWeek = Number(config.runDaysPerWeek);
    if (![3, 4].includes(runDaysPerWeek)) {
      return { valid: false, error: 'HYROX availability requires 3 or 4 run days per week. Choose 3 or 4.' };
    }
    if (!Array.isArray(config.trainingDays) || config.trainingDays.some((day) => !HYROX_TRAINING_DAYS.has(day))) {
      return { valid: false, error: 'HYROX training days must use Mon through Sun. Choose only supported weekdays.' };
    }
    const trainingDays = [...new Set(config.trainingDays)];
    if (trainingDays.length < runDaysPerWeek) {
      return {
        valid: false,
        error: `HYROX with ${runDaysPerWeek} run days needs at least ${runDaysPerWeek} training weekdays. Select at least ${runDaysPerWeek}.`,
      };
    }
    eventConfig.runDaysPerWeek = runDaysPerWeek;
    eventConfig.trainingDays = trainingDays;
  }
  return {
    valid: true,
    value: {
      race_name: raceName,
      race_date: localDate,
      distance_miles: distanceMiles,
      location: cleanString(body.location, 200) || null,
      goal_time_seconds: goalTimeSeconds,
      status,
      notes: cleanString(body.notes, 2000) || null,
      event_kind: eventKind,
      event_format: eventFormat,
      event_category: eventCategory,
      event_local_date: localDate,
      event_timezone: timezone,
      rules_version: rulesVersion,
      event_config_json: JSON.stringify(eventConfig),
    },
  };
}

function catalogEnvelopeJson(catalogRace) {
  const existing = raceCourse.readCourseEnvelope(catalogRace.course_profile_json);
  if (raceCourse.isEnvelope(existing)) return JSON.stringify(existing);
  return JSON.stringify(raceCourse.buildCatalogCourseEnvelope(catalogRace, {
    asOf: catalogRace.created_at || null,
    provenance: 'curated',
  }));
}

function catalogRaceFields(catalogRace) {
  const locationParts = [catalogRace.city, catalogRace.state].filter(Boolean);
  const location = locationParts.length ? locationParts.join(', ') : (catalogRace.country || null);
  return {
    race_name: catalogRace.name,
    race_date: catalogRace.race_date,
    distance_miles: Number(catalogRace.distance_miles),
    location: location ? location.trim() : null,
    elevation_gain_ft: catalogRace.elevation_gain_ft ?? null,
    max_altitude_ft: catalogRace.max_altitude_ft ?? null,
    terrain: catalogRace.terrain || null,
    course_profile_json: catalogEnvelopeJson(catalogRace),
    source: catalogRace.source || null,
    url: catalogRace.url || null,
  };
}

function isSameCatalogEdition(race, catalogRace) {
  if (!race || !catalogRace) return false;
  if (String(race.race_date) !== String(catalogRace.race_date)) return false;
  if (Number(race.distance_miles) !== Number(catalogRace.distance_miles)) return false;
  const envelope = raceCourse.readCourseEnvelope(race.course_profile_json);
  if (raceCourse.isEnvelope(envelope) && envelope.editionId) {
    return String(envelope.editionId) === String(catalogRace.id);
  }
  return raceCourse.normalizeRaceName(race.race_name) === raceCourse.normalizeRaceName(catalogRace.name);
}

function receiveGpx(req, res, next) {
  gpxUpload.single('gpx')(req, res, (err) => {
    if (!err) return next();
    console.error('[races/gpx] upload rejected:', err.message);
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'GPX file exceeds the 2 MB limit' : 'Invalid GPX upload' });
  });
}

// Serialize a user-facing race with its honest course-intelligence state and
// without leaking raw GPX coordinates.
function withCourseIntelligence(race) {
  if (!race) return race;
  const intelligence = raceCourse.courseIntelligenceForRace(race);
  const lifecycle = readRaceEventLifecycle(race);
  return Object.assign({}, race, lifecycle, { course_intelligence: intelligence });
}

router.get('/', auth, async (req, res) => {
  try {
    const items = await dbAll('SELECT * FROM race_events WHERE user_id=? ORDER BY race_date ASC', [req.user.id]);
    res.json({ races: items.map(withCourseIntelligence) });
  } catch (err) {
    console.error('[races/list] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch races' });
  }
});

router.get('/next', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const race = await dbGet("SELECT * FROM race_events WHERE user_id=? AND status='upcoming' AND race_date>=? ORDER BY race_date ASC LIMIT 1", [req.user.id, today]);
    res.json({ race: race ? withCourseIntelligence(race) : null });
  } catch (err) {
    console.error('[races/next] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch next race' });
  }
});

router.get('/catalog', auth, async (req, res) => {
  try {
    const { q, distance, month, state } = req.query || {};
    const where = [];
    const params = [];

    if (q && String(q).trim()) {
      const searchTokens = raceCourse.normalizeCatalogSearchTokens(q);
      if (searchTokens.length === 0) {
        where.push('1=0');
      } else {
        for (const token of searchTokens) {
          where.push('(name ILIKE ? OR city ILIKE ? OR state ILIKE ? OR country ILIKE ?)');
          const pattern = `%${token}%`;
          params.push(pattern, pattern, pattern, pattern);
        }
      }
    }

    if (distance !== undefined && distance !== '') {
      const distanceMiles = Number(distance);
      if (!Number.isFinite(distanceMiles)) return res.status(400).json({ error: 'distance must be a number' });
      where.push('distance_miles BETWEEN ? AND ?');
      params.push(distanceMiles - 1, distanceMiles + 1);
    }

    if (month !== undefined && month !== '') {
      const monthNumber = Number(month);
      if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
        return res.status(400).json({ error: 'month must be an integer from 1 to 12' });
      }
      where.push('(EXTRACT(MONTH FROM race_date::date) = ? OR substring(race_date from 6 for 2) = ?)');
      params.push(monthNumber, String(monthNumber).padStart(2, '0'));
    }

    if (state && String(state).trim()) {
      where.push('state = ?');
      params.push(String(state).trim().toUpperCase());
    }

    const sql = `
      SELECT *
      FROM race_catalog
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY
        CASE scope WHEN 'local' THEN 0 WHEN 'regional' THEN 1 ELSE 2 END,
        race_date ASC
      LIMIT 50
    `;
    const races = await dbAll(sql, params);
    res.json({ races: races.map(withCourseIntelligence) });
  } catch (err) {
    console.error('[races/catalog] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch race catalog' });
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const normalized = normalizeRaceEvent(body);
    if (!normalized.valid) return res.status(400).json({ error: normalized.error });
    const event = normalized.value;
    const race_name = event.race_name;
    const race_date = event.race_date;
    const distance = event.distance_miles;
    const location = event.location;

    // H7: try to resolve to an unambiguous current catalog edition and copy the
    // canonical course envelope. Never silently pick a wrong edition; otherwise
    // preserve exactly the typed name/date/distance as an unknown/manual record.
    let course = { elevation_gain_ft: null, max_altitude_ft: null, terrain: null, course_profile_json: null, source: null, url: null };
    if (event.event_kind === 'run_race') {
      try {
        const catalog = await dbAll('SELECT * FROM race_catalog', []);
        const resolution = raceCourse.resolveCatalogRace({
          catalog,
          name: race_name,
          date: race_date,
          distanceMiles: distance,
          location,
        });
        if (resolution.status === 'resolved' && resolution.race) {
          const matched = resolution.race;
          course = {
            elevation_gain_ft: matched.elevation_gain_ft || null,
            max_altitude_ft: matched.max_altitude_ft || null,
            terrain: matched.terrain || null,
            course_profile_json: catalogEnvelopeJson(matched),
            source: matched.source || null,
            url: matched.url || null,
          };
        }
      } catch (resolveErr) {
        console.error('[races/create] catalog resolution failed, using manual fallback:', resolveErr.message);
      }
    }

    const id = uuidv4();
    const race = await withPlanningInputMutation(req.user.id, async (tx) => {
      await tx.run(
        `INSERT INTO race_events (
          id, user_id, race_name, race_date, distance_miles, location, goal_time_seconds, status, notes,
          elevation_gain_ft, max_altitude_ft, terrain, course_profile_json, source, url,
          event_kind, event_format, event_category, event_local_date, event_timezone, rules_version, event_config_json
        )
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, req.user.id, race_name, race_date, distance, location, event.goal_time_seconds, event.status, event.notes,
          course.elevation_gain_ft, course.max_altitude_ft, course.terrain, course.course_profile_json, course.source, course.url,
          event.event_kind, event.event_format, event.event_category, event.event_local_date,
          event.event_timezone, event.rules_version, event.event_config_json,
        ]
      );
      return tx.get('SELECT * FROM race_events WHERE id=? AND user_id=?', [id, req.user.id]);
    });
    res.status(201).json({ race: withCourseIntelligence(race) });
  } catch (err) {
    console.error('[races/create] failed:', err.message);
    res.status(500).json({ error: 'Failed to add race' });
  }
});

router.post('/from-catalog/:catalogId', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const hasGoalTime = Object.prototype.hasOwnProperty.call(body, 'goal_time_seconds');
    const requestedGoalTime = parseGoalTime(body.goal_time_seconds);
    if (Number.isNaN(requestedGoalTime)) return res.status(400).json({ error: 'goal_time_seconds is invalid' });

    const catalogRace = await dbGet('SELECT * FROM race_catalog WHERE id=?', [req.params.catalogId]);
    if (!catalogRace) return res.status(404).json({ error: 'Catalog race not found' });

    const canonical = catalogRaceFields(catalogRace);
    const mutation = await withPlanningInputMutation(req.user.id, async (tx) => {
      const candidates = await tx.all(
        `SELECT * FROM race_events
         WHERE user_id=? AND race_date=? AND distance_miles=?
         ORDER BY created_at ASC, id ASC
         FOR UPDATE`,
        [req.user.id, canonical.race_date, canonical.distance_miles]
      );
      const existingRace = candidates.find((race) => isSameCatalogEdition(race, catalogRace));

      if (existingRace) {
        const goalTimeSeconds = hasGoalTime ? requestedGoalTime : (existingRace.goal_time_seconds ?? null);
        await tx.run(
          `UPDATE race_events
           SET race_name=?, race_date=?, distance_miles=?, location=?, goal_time_seconds=?,
               elevation_gain_ft=?, max_altitude_ft=?, terrain=?, course_profile_json=?, source=?, url=?
           WHERE id=? AND user_id=?`,
          [
            canonical.race_name,
            canonical.race_date,
            canonical.distance_miles,
            canonical.location,
            goalTimeSeconds,
            canonical.elevation_gain_ft,
            canonical.max_altitude_ft,
            canonical.terrain,
            canonical.course_profile_json,
            canonical.source,
            canonical.url,
            existingRace.id,
            req.user.id,
          ]
        );
        await tx.run(
          `UPDATE race_events
           SET event_kind=?, event_format=?, event_category=?, event_local_date=?,
               event_timezone=?, rules_version=?, event_config_json=?
           WHERE id=? AND user_id=?`,
          [
            'run_race', null, null, canonical.race_date, null, null,
            JSON.stringify({ schemaVersion: 1, equipment: [], runningPriority: 'maintain' }),
            existingRace.id, req.user.id,
          ],
        );
        const refreshed = await tx.get('SELECT * FROM race_events WHERE id=? AND user_id=?', [existingRace.id, req.user.id]);
        return { race: refreshed, existing: true };
      }

      const id = uuidv4();
      await tx.run(
        `INSERT INTO race_events (
          id, user_id, race_name, race_date, distance_miles, location, goal_time_seconds, status,
          elevation_gain_ft, max_altitude_ft, terrain, course_profile_json, source, url,
          event_kind, event_format, event_category, event_local_date, event_timezone, rules_version, event_config_json
         )
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          req.user.id,
          canonical.race_name,
          canonical.race_date,
          canonical.distance_miles,
          canonical.location,
          requestedGoalTime,
          'upcoming',
          canonical.elevation_gain_ft,
          canonical.max_altitude_ft,
          canonical.terrain,
          canonical.course_profile_json,
          canonical.source,
          canonical.url,
          'run_race', null, null, canonical.race_date, null, null,
          JSON.stringify({ schemaVersion: 1, equipment: [], runningPriority: 'maintain' })
        ]
      );
      const race = await tx.get('SELECT * FROM race_events WHERE id=? AND user_id=?', [id, req.user.id]);
      return { race, existing: false };
    });
    res.status(mutation.existing ? 200 : 201).json({
      race: withCourseIntelligence(mutation.race),
      existing: mutation.existing,
    });
  } catch (err) {
    console.error('[races/from-catalog] failed:', err.message);
    res.status(500).json({ error: 'Failed to add race from catalog' });
  }
});

// H7: privacy-safe user GPX course upload for an existing, owned race. Stores
// only distance/elevation samples and privacy metadata — never raw coordinates.
router.post('/:id/course/gpx', auth, gpxUploadLimiter, receiveGpx, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ error: 'gpx file is required' });
    }
    const race = await dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!race) return res.status(404).json({ error: 'Race not found' });

    let analysis;
    try {
      analysis = await raceCourse.analyzeGpx(req.file.buffer, { maxBytes: raceCourse.GPX_MAX_BYTES });
    } catch (parseErr) {
      console.error('[races/gpx] analysis rejected:', parseErr.message);
      return res.status(400).json({ error: `Could not read GPX: ${parseErr.message}` });
    }

    const mutation = await withPlanningInputMutation(req.user.id, async (tx) => {
      const ownedRace = await tx.get(
        'SELECT * FROM race_events WHERE id=? AND user_id=? FOR UPDATE',
        [req.params.id, req.user.id]
      );
      if (!ownedRace) return planningInputUnchanged({ notFound: true });
      if (!raceCourse.courseDistanceMatchesRace(analysis.distanceMiles, ownedRace.distance_miles)) {
        return planningInputUnchanged({
          validationError: `GPX distance (${analysis.distanceMiles} mi) does not match this ${Number(ownedRace.distance_miles)} mi race`,
        });
      }
      const envelope = raceCourse.buildUserGpxEnvelope(analysis, {
        baseEnvelope: ownedRace.course_profile_json,
        raceDate: ownedRace.race_date,
      });
      await tx.run(
        `UPDATE race_events
         SET elevation_gain_ft=?, max_altitude_ft=?, terrain=?, course_profile_json=?, source=?
         WHERE id=? AND user_id=?`,
        [
          analysis.elevationGainFt,
          analysis.maxAltitudeFt,
          analysis.terrain,
          JSON.stringify(envelope),
          'user_gpx',
          req.params.id,
          req.user.id,
        ]
      );
      return {
        updated: await tx.get(
          'SELECT * FROM race_events WHERE id=? AND user_id=?',
          [req.params.id, req.user.id]
        ),
      };
    });
    if (mutation.notFound) return res.status(404).json({ error: 'Race not found' });
    if (mutation.validationError) return res.status(400).json({ error: mutation.validationError });
    const updated = mutation.updated;
    res.json({
      race: withCourseIntelligence(updated),
      analysis: {
        distanceMiles: analysis.distanceMiles,
        elevationGainFt: analysis.elevationGainFt,
        maxAltitudeFt: analysis.maxAltitudeFt,
        terrain: analysis.terrain,
        pointCount: analysis.pointCount,
        privacy: analysis.privacy,
      },
    });
  } catch (err) {
    console.error('[races/gpx] failed:', err.message);
    res.status(500).json({ error: 'Failed to process GPX course' });
  }
});

router.post('/:id/removal-preview', auth, async (req, res) => {
  try {
    const planningClock = plansRouter._test.withRequestPlanningClock(req, {
      planning_date_local: req.body?.planning_date_local,
      timezone_offset_minutes: req.body?.timezone_offset_minutes,
    });
    const preview = await plansRouter._test.previewRaceRemovalForUser(req.user.id,
      String(req.params.id || ''),
      planningClock,
    );
    return res.status(preview.requires_apply ? 201 : 200).json(preview);
  } catch (err) {
    const status = Number(err?.status) || 500;
    console.error('[races/removal-preview] failed:', err.message);
    return res.status(status).json({
      error: status >= 500 ? 'Unable to preview race removal.' : err.message,
      code: err.code || 'RACE_REMOVAL_PREVIEW_FAILED',
    });
  }
});

// Race ownership actions must not be blocked by the premium gate protecting
// generic plan generation. This endpoint can only apply a stored candidate
// whose immutable snapshot removes this exact owned race.
router.post('/:id/removal-apply', auth, async (req, res) => {
  try {
    const candidateId = String(req.body?.candidate_id || '').trim();
    if (!candidateId || candidateId.length > 128) {
      return res.status(400).json({ error: 'Removal candidate is required.', code: 'INVALID_CANDIDATE_ID' });
    }
    const applyEnvelope = goalBackwardApplyEnvelopeFromRequest(req.body, candidateId);
    const applyInput = plansRouter._test.withRequestPlanningClock(req, {
      ...applyEnvelope,
      candidate_hash: req.body?.candidate_hash,
      choice: req.body?.choice,
      planning_date_local: req.body?.planning_date_local,
      timezone_offset_minutes: req.body?.timezone_offset_minutes,
    });
    const result = await plansRouter._test.applyPlanCandidate(
      req.user.id,
      candidateId,
      applyInput,
      { requiredOperation: 'remove_race', requiredRaceId: String(req.params.id || '') },
    );
    if (result.error) return res.status(result.status || 409).json({ error: result.error, code: result.code });
    return res.status(result.status || 200).json({ ...result.payload, replay: Boolean(result.replay) });
  } catch (err) {
    const status = Number(err?.status) || 500;
    console.error('[races/removal-apply] failed:', err.message);
    return res.status(status).json({
      error: status >= 500 ? 'Unable to apply race removal.' : err.message,
      code: status >= 500 ? 'RACE_REMOVAL_APPLY_FAILED' : (err.code || 'RACE_REMOVAL_APPLY_FAILED'),
    });
  }
});

router.post('/:id/removal-reset', auth, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || body.confirmation !== PLAN_RESET_CONFIRMATION) {
    return res.status(400).json({
      error: 'Type the exact confirmation before clearing the active plan and removing this race.',
      code: 'INVALID_REMOVAL_RESET_CONFIRMATION',
    });
  }

  try {
    const result = await withPlanningInputMutation(req.user.id, async (tx) => {
      const race = await tx.get(
        'SELECT id FROM race_events WHERE id=? AND user_id=? FOR UPDATE',
        [req.params.id, req.user.id],
      );
      if (!race) return planningInputUnchanged({ notFound: true });

      const planClear = await plansRouter._test.clearActivePlanForUser(req.user.id, tx);
      await tx.run(
        "UPDATE plan_generation_candidates SET status='superseded' WHERE user_id=? AND status='preview'",
        [req.user.id],
      );
      const removed = await tx.run(
        'DELETE FROM race_events WHERE id=? AND user_id=?',
        [req.params.id, req.user.id],
      );
      if (removed.changes !== 1) throw new Error('Owned race reset deletion failed');
      return {
        ok: true,
        race_removed: true,
        active_plan_cleared: planClear.cleared,
        history_preserved: true,
      };
    });
    if (result.notFound) {
      return res.status(404).json({ error: 'Race not found', code: 'RACE_NOT_FOUND' });
    }
    return res.json(result);
  } catch (err) {
    console.error('[races/removal-reset] failed:', err.message);
    return res.status(500).json({
      error: 'Unable to clear the active plan and remove this race. Nothing was changed.',
      code: 'RACE_REMOVAL_RESET_FAILED',
    });
  }
});

router.patch('/:id', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const mutation = await withPlanningInputMutation(req.user.id, async (tx) => {
      const race = await tx.get(
        'SELECT * FROM race_events WHERE id=? AND user_id=? FOR UPDATE',
        [req.params.id, req.user.id]
      );
      if (!race) return planningInputUnchanged({ notFound: true });
      if (!Object.keys(body).length) return planningInputUnchanged({ updated: race, unchanged: true });

      let lifecycle;
      try {
        lifecycle = transitionRaceEventLifecycle(race, body);
      } catch (error) {
        return planningInputUnchanged({ validationError: error.message, validationCode: error.code });
      }
      if (!lifecycle.changed) return planningInputUnchanged({ updated: race, unchanged: true });
      const normalized = normalizeRaceEvent({
        ...race,
        ...body,
        ...lifecycle,
        event_kind: body.event_kind ?? race.event_kind ?? 'run_race',
        event_local_date: lifecycle.event_local_date,
        event_config_json: lifecycle.event_config_json,
      });
      if (!normalized.valid) return planningInputUnchanged({ validationError: normalized.error });
      const next = normalized.value;
      const identityChanged = raceCourse.normalizeRaceName(next.race_name) !== raceCourse.normalizeRaceName(race.race_name)
        || String(next.race_date) !== String(race.race_date)
        || Math.abs(Number(next.distance_miles) - Number(race.distance_miles)) >= 0.01
        || String(next.location || '').trim().toLowerCase() !== String(race.location || '').trim().toLowerCase()
        || String(next.event_kind) !== String(race.event_kind || 'run_race')
        || String(next.event_format || '') !== String(race.event_format || '')
        || String(next.event_category || '') !== String(race.event_category || '');
      const course = identityChanged
        ? { elevation_gain_ft: null, max_altitude_ft: null, terrain: null, course_profile_json: null, source: null, url: null }
        : race;
      await tx.run(
        `UPDATE race_events
         SET race_name=?, race_date=?, distance_miles=?, location=?, goal_time_seconds=?, status=?, notes=?,
             elevation_gain_ft=?, max_altitude_ft=?, terrain=?, course_profile_json=?, source=?, url=?,
             event_kind=?, event_format=?, event_category=?, event_local_date=?, event_timezone=?, rules_version=?, event_config_json=?
         WHERE id=? AND user_id=?`,
        [
          next.race_name, next.race_date, next.distance_miles, next.location, next.goal_time_seconds, next.status, next.notes,
          course.elevation_gain_ft, course.max_altitude_ft, course.terrain, course.course_profile_json, course.source, course.url,
          next.event_kind, next.event_format, next.event_category, next.event_local_date,
          next.event_timezone, next.rules_version, next.event_config_json,
          req.params.id, req.user.id,
        ]
      );
      return {
        updated: await tx.get(
          'SELECT * FROM race_events WHERE id=? AND user_id=?',
          [req.params.id, req.user.id]
        ),
      };
    });
    if (mutation.notFound) return res.status(404).json({ error: 'Race not found' });
    if (mutation.validationError) return res.status(400).json({ error: mutation.validationError });
    res.json({ race: withCourseIntelligence(mutation.updated) });
  } catch (err) {
    console.error('[races/patch] failed:', err.message);
    res.status(500).json({ error: 'Update failed' });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const mutation = await withPlanningInputMutation(req.user.id, async (tx) => {
      const race = await tx.get(
        'SELECT id FROM race_events WHERE id=? AND user_id=? FOR UPDATE',
        [req.params.id, req.user.id],
      );
      if (!race) return planningInputUnchanged({ notFound: true });
      const impact = await plansRouter._test.raceRemovalImpactForUser(req.user.id, req.params.id, tx);
      if (impact?.rejected === true || typeof impact?.linked !== 'boolean') {
        return planningInputUnchanged({ linkageUnverified: true });
      }
      if (impact.linked) return planningInputUnchanged({ rebuildRequired: true });
      const result = await tx.run('DELETE FROM race_events WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
      if (!result.changes) throw new Error('Owned race deletion failed');
      return { ok: true };
    });
    if (mutation.notFound) return res.status(404).json({ error: 'Race not found', code: 'RACE_NOT_FOUND' });
    if (mutation.linkageUnverified) {
      return res.status(409).json({
        error: 'The active plan race bindings could not be verified. Preview removal again before deleting this race.',
        code: 'ACTIVE_PLAN_LINKAGE_UNVERIFIED',
      });
    }
    if (mutation.rebuildRequired) {
      return res.status(409).json({
        error: 'Preview and apply the active-plan rebuild before removing this race.',
        code: 'ACTIVE_PLAN_REBUILD_REQUIRED',
      });
    }
    res.json(mutation);
  } catch (err) {
    console.error('[races/delete] failed:', err.message);
    res.status(500).json({ error: 'Delete failed' });
  }
});

router._test = {
  PLAN_RESET_CONFIRMATION,
  normalizeRaceEvent,
  readRaceEventLifecycle,
  transitionRaceEventLifecycle,
};

module.exports = router;
