const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

router.get('/', auth, (req, res) => {
  const items = db.prepare('SELECT * FROM race_events WHERE user_id=? ORDER BY race_date ASC').all(req.user.id);
  res.json({ races: items });
});

router.get('/next', auth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const race = db.prepare("SELECT * FROM race_events WHERE user_id=? AND status='upcoming' AND race_date>=? ORDER BY race_date ASC LIMIT 1").get(req.user.id, today);
  res.json({ race: race || null });
});

router.post('/', auth, (req, res) => {
  const { race_name, race_date, distance_miles, location, goal_time_seconds, status = 'upcoming', notes } = req.body || {};
  if (!race_name || !race_date || !distance_miles) return res.status(400).json({ error: 'race_name, race_date, distance_miles are required' });

  const id = uuidv4();
  db.prepare(`INSERT INTO race_events (id, user_id, race_name, race_date, distance_miles, location, goal_time_seconds, status, notes)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, req.user.id, race_name, race_date, Number(distance_miles), location || null, goal_time_seconds || null, status, notes || null);

  const race = db.prepare('SELECT * FROM race_events WHERE id=?').get(id);
  res.status(201).json({ race });
});

router.patch('/:id', auth, (req, res) => {
  const race = db.prepare('SELECT * FROM race_events WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!race) return res.status(404).json({ error: 'Race not found' });

  const next = { ...race, ...req.body };
  db.prepare(`UPDATE race_events SET race_name=?, race_date=?, distance_miles=?, location=?, goal_time_seconds=?, status=?, notes=? WHERE id=? AND user_id=?`)
    .run(next.race_name, next.race_date, next.distance_miles, next.location, next.goal_time_seconds, next.status, next.notes, req.params.id, req.user.id);

  res.json({ race: db.prepare('SELECT * FROM race_events WHERE id=?').get(req.params.id) });
});

router.delete('/:id', auth, (req, res) => {
  db.prepare('DELETE FROM race_events WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;