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
