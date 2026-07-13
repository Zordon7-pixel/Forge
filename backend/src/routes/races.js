const router = require('express').Router();
const multer = require('multer');
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const raceCourse = require('../lib/raceCourse');

// GPX uploads are held in memory only; raw coordinates are never persisted.
const gpxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: raceCourse.GPX_MAX_BYTES, files: 1 },
});

function cleanString(value, maxLen = 200) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\r\n]+/g, ' ').trim().slice(0, maxLen);
}

function isValidISODate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
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
      where.push('name ILIKE ?');
      params.push(`%${String(q).trim()}%`);
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
    res.json({ races });
  } catch (err) {
    console.error('[races/catalog] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch race catalog' });
  }
});

// H7: pre-save resolution preview. Never guesses a nearest race or wrong edition.
router.post('/resolve', auth, async (req, res) => {
  try {
    const raceName = cleanString(req.body && req.body.race_name, 200);
    const raceDate = req.body && req.body.race_date;
    const distanceMiles = req.body && req.body.distance_miles;
    if (!raceName) return res.status(400).json({ error: 'race_name is required' });
    if (raceDate !== undefined && raceDate !== null && raceDate !== '' && !isValidISODate(raceDate)) {
      return res.status(400).json({ error: 'race_date must be YYYY-MM-DD' });
    }
    const distance = distanceMiles === undefined || distanceMiles === null || distanceMiles === ''
      ? null : Number(distanceMiles);
    if (distance !== null && (!Number.isFinite(distance) || distance <= 0 || distance > 200)) {
      return res.status(400).json({ error: 'distance_miles must be a positive number' });
    }

    const catalog = await dbAll('SELECT * FROM race_catalog', []);
    const resolution = raceCourse.resolveCatalogRace({
      catalog,
      name: raceName,
      date: isValidISODate(raceDate) ? raceDate : null,
      distanceMiles: distance,
    });
    const matched = resolution.race || null;
    res.json({
      status: resolution.status,
      reason: resolution.reason,
      race: matched,
      course_intelligence: matched ? raceCourse.courseIntelligenceForRace(matched) : null,
    });
  } catch (err) {
    console.error('[races/resolve] failed:', err.message);
    res.status(500).json({ error: 'Failed to resolve race' });
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const race_name = cleanString(req.body && req.body.race_name, 200);
    const { race_date, distance_miles, location, goal_time_seconds, status = 'upcoming', notes } = req.body || {};
    if (!race_name || !race_date || !distance_miles) return res.status(400).json({ error: 'race_name, race_date, distance_miles are required' });
    if (!isValidISODate(race_date)) return res.status(400).json({ error: 'race_date must be YYYY-MM-DD' });
    const distance = Number(distance_miles);
    if (!Number.isFinite(distance) || distance <= 0 || distance > 200) return res.status(400).json({ error: 'distance_miles must be a positive number' });

    // H7: try to resolve to an unambiguous current catalog edition and copy the
    // canonical course envelope. Never silently pick a wrong edition; otherwise
    // preserve exactly the typed name/date/distance as an unknown/manual record.
    let course = { elevation_gain_ft: null, max_altitude_ft: null, terrain: null, course_profile_json: null, source: null, url: null };
    try {
      const catalog = await dbAll('SELECT * FROM race_catalog', []);
      const resolution = raceCourse.resolveCatalogRace({
        catalog,
        name: race_name,
        date: race_date,
        distanceMiles: distance,
      });
      if (resolution.status === 'resolved' && resolution.race) {
        const matched = resolution.race;
        course = {
          elevation_gain_ft: matched.elevation_gain_ft || null,
          max_altitude_ft: matched.max_altitude_ft || null,
          terrain: matched.terrain || null,
          course_profile_json: matched.course_profile_json || JSON.stringify(raceCourse.buildCatalogCourseEnvelope(matched, { provenance: 'curated' })),
          source: matched.source || null,
          url: matched.url || null,
        };
      }
    } catch (resolveErr) {
      console.error('[races/create] catalog resolution failed, using manual fallback:', resolveErr.message);
    }

    const id = uuidv4();
    await dbRun(
      `INSERT INTO race_events (
        id, user_id, race_name, race_date, distance_miles, location, goal_time_seconds, status, notes,
        elevation_gain_ft, max_altitude_ft, terrain, course_profile_json, source, url
      )
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, req.user.id, race_name, race_date, distance, location || null, goal_time_seconds || null, status, notes || null,
        course.elevation_gain_ft, course.max_altitude_ft, course.terrain, course.course_profile_json, course.source, course.url,
      ]
    );

    const race = await dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [id, req.user.id]);
    res.status(201).json({ race: withCourseIntelligence(race) });
  } catch (err) {
    console.error('[races/create] failed:', err.message);
    res.status(500).json({ error: 'Failed to add race' });
  }
});

router.post('/from-catalog/:catalogId', auth, async (req, res) => {
  try {
    const catalogRace = await dbGet('SELECT * FROM race_catalog WHERE id=?', [req.params.catalogId]);
    if (!catalogRace) return res.status(404).json({ error: 'Catalog race not found' });

    const locationParts = [catalogRace.city, catalogRace.state].filter(Boolean);
    const location = locationParts.length ? locationParts.join(', ') : (catalogRace.country || null);
    const id = uuidv4();

    // Embed the canonical/provenance envelope, not just loose course fields.
    const envelopeJson = catalogRace.course_profile_json
      || JSON.stringify(raceCourse.buildCatalogCourseEnvelope(catalogRace, { provenance: 'curated' }));

    await dbRun(
      `INSERT INTO race_events (
        id, user_id, race_name, race_date, distance_miles, location, status,
        elevation_gain_ft, max_altitude_ft, terrain, course_profile_json, source, url
       )
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        req.user.id,
        catalogRace.name,
        catalogRace.race_date,
        Number(catalogRace.distance_miles),
        location ? location.trim() : null,
        'upcoming',
        catalogRace.elevation_gain_ft || null,
        catalogRace.max_altitude_ft || null,
        catalogRace.terrain || null,
        envelopeJson,
        catalogRace.source || null,
        catalogRace.url || null
      ]
    );

    const race = await dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [id, req.user.id]);
    res.status(201).json({ race: withCourseIntelligence(race) });
  } catch (err) {
    console.error('[races/from-catalog] failed:', err.message);
    res.status(500).json({ error: 'Failed to add race from catalog' });
  }
});

// H7: privacy-safe user GPX course upload for an existing, owned race. Stores
// only distance/elevation samples and privacy metadata — never raw coordinates.
router.post('/:id/course/gpx', auth, gpxUpload.single('gpx'), async (req, res) => {
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

    const envelope = raceCourse.buildUserGpxEnvelope(analysis);
    await dbRun(
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

    const updated = await dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
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

router.patch('/:id', auth, async (req, res) => {
  try {
    const race = await dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!race) return res.status(404).json({ error: 'Race not found' });

    const next = { ...race, ...req.body };
    await dbRun(
      `UPDATE race_events SET race_name=?, race_date=?, distance_miles=?, location=?, goal_time_seconds=?, status=?, notes=? WHERE id=? AND user_id=?`,
      [next.race_name, next.race_date, next.distance_miles, next.location, next.goal_time_seconds, next.status, next.notes, req.params.id, req.user.id]
    );

    const updated = await dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ race: withCourseIntelligence(updated) });
  } catch (err) {
    console.error('[races/patch] failed:', err.message);
    res.status(500).json({ error: 'Update failed' });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await dbRun('DELETE FROM race_events WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[races/delete] failed:', err.message);
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
