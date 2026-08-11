const router = require('express').Router();
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { dbGet, dbAll, withPlanningInputMutation } = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const raceCourse = require('../lib/raceCourse');
const { planningInputUnchanged } = require('../lib/planningRevision');
const hyroxStandards = require('../lib/hyroxStandards');
const { isIanaTimezone } = require('../lib/hyroxPlan');
const plansRouter = require('./plans');

// GPX uploads are held in memory only; raw coordinates are never persisted.
const gpxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: raceCourse.GPX_MAX_BYTES, files: 1 },
});
const RACE_STATUSES = new Set(['upcoming', 'completed', 'cancelled']);
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

function normalizeRaceEvent(body = {}) {
  const raceName = cleanString(body.race_name, 200);
  const eventKind = cleanString(body.event_kind || 'run_race', 20).toLowerCase();
  const localDate = cleanString(body.event_local_date || body.race_date, 10);
  const timezone = cleanString(body.event_timezone, 100) || null;
  const status = cleanString(body.status || 'upcoming', 20).toLowerCase();
  const goalTimeSeconds = parseGoalTime(body.goal_time_seconds);
  if (!raceName) return { valid: false, error: 'race_name is required' };
  if (!['run_race', 'hyrox'].includes(eventKind)) return { valid: false, error: 'event_kind is invalid' };
  if (!isValidISODate(localDate)) return { valid: false, error: 'event_local_date must be YYYY-MM-DD' };
  if (timezone && !isIanaTimezone(timezone)) return { valid: false, error: 'event_timezone must be a valid IANA timezone' };
  if (!RACE_STATUSES.has(status)) return { valid: false, error: 'status is invalid' };
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
    distanceMiles = hyroxStandards.HYROX_RUN_DISTANCE_MILES;
  } else if (!Number.isFinite(distanceMiles) || distanceMiles <= 0 || distanceMiles > 100) {
    return { valid: false, error: 'distance_miles must be between 0 and 100' };
  }
  const equipment = hyroxStandards.normalizeEquipment(config.equipment);
  const runningPriority = ['maintain', 'improve', 'race_pr'].includes(config.runningPriority)
    ? config.runningPriority : 'maintain';
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
      event_config_json: JSON.stringify({ schemaVersion: 1, equipment, runningPriority }),
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
  return Object.assign({}, race, { course_intelligence: intelligence });
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
    const preview = await plansRouter._test.previewRaceRemovalForUser(req.user.id,
      String(req.params.id || ''),
      plansRouter._test.withRequestPlanningClock(req, req.body || {}),
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

router.patch('/:id', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const mutation = await withPlanningInputMutation(req.user.id, async (tx) => {
      const race = await tx.get(
        'SELECT * FROM race_events WHERE id=? AND user_id=? FOR UPDATE',
        [req.params.id, req.user.id]
      );
      if (!race) return planningInputUnchanged({ notFound: true });

      const normalized = normalizeRaceEvent({
        ...race,
        ...body,
        event_kind: body.event_kind ?? race.event_kind ?? 'run_race',
        event_local_date: body.event_local_date ?? body.race_date ?? race.event_local_date ?? race.race_date,
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
      if (impact.linked) return planningInputUnchanged({ rebuildRequired: true });
      const result = await tx.run('DELETE FROM race_events WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
      if (!result.changes) throw new Error('Owned race deletion failed');
      return { ok: true };
    });
    if (mutation.notFound) return res.status(404).json({ error: 'Race not found', code: 'RACE_NOT_FOUND' });
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

router._test = { normalizeRaceEvent };

module.exports = router;
