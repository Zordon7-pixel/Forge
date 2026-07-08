const router = require('express').Router();
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

router.get('/', auth, async (req, res) => {
  try {
    const items = await dbAll('SELECT * FROM race_events WHERE user_id=? ORDER BY race_date ASC', [req.user.id]);
    res.json({ races: items });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch races' }); }
});

router.get('/next', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const race = await dbGet("SELECT * FROM race_events WHERE user_id=? AND status='upcoming' AND race_date>=? ORDER BY race_date ASC LIMIT 1", [req.user.id, today]);
    res.json({ race: race || null });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch next race' }); }
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
  } catch (err) { res.status(500).json({ error: 'Failed to fetch race catalog' }); }
});

router.post('/', auth, async (req, res) => {
  try {
    const { race_name, race_date, distance_miles, location, goal_time_seconds, status = 'upcoming', notes } = req.body || {};
    if (!race_name || !race_date || !distance_miles) return res.status(400).json({ error: 'race_name, race_date, distance_miles are required' });

    const id = uuidv4();
    await dbRun(
      `INSERT INTO race_events (id, user_id, race_name, race_date, distance_miles, location, goal_time_seconds, status, notes)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, req.user.id, race_name, race_date, Number(distance_miles), location || null, goal_time_seconds || null, status, notes || null]
    );

    const race = await dbGet('SELECT * FROM race_events WHERE id=?', [id]);
    res.status(201).json({ race });
  } catch (err) { res.status(500).json({ error: 'Failed to add race' }); }
});

router.post('/from-catalog/:catalogId', auth, async (req, res) => {
  try {
    const catalogRace = await dbGet('SELECT * FROM race_catalog WHERE id=?', [req.params.catalogId]);
    if (!catalogRace) return res.status(404).json({ error: 'Catalog race not found' });

    const locationParts = [catalogRace.city, catalogRace.state].filter(Boolean);
    const location = locationParts.length ? locationParts.join(', ') : (catalogRace.country || null);
    const id = uuidv4();

    await dbRun(
      `INSERT INTO race_events (id, user_id, race_name, race_date, distance_miles, location, status)
       VALUES (?,?,?,?,?,?,?)`,
      [
        id,
        req.user.id,
        catalogRace.name,
        catalogRace.race_date,
        Number(catalogRace.distance_miles),
        location ? location.trim() : null,
        'upcoming'
      ]
    );

    const race = await dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [id, req.user.id]);
    res.status(201).json({ race });
  } catch (err) { res.status(500).json({ error: 'Failed to add race from catalog' }); }
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

    const updated = await dbGet('SELECT * FROM race_events WHERE id=?', [req.params.id]);
    res.json({ race: updated });
  } catch (err) { res.status(500).json({ error: 'Update failed' }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await dbRun('DELETE FROM race_events WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

module.exports = router;
