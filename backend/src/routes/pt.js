const router = require('express').Router();
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

const ALLOWED_MILESTONES = new Set(['first_walk', 'first_jog', 'first_run', 'pain_free_day']);

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function toDayDiff(fromDate, toDate = new Date()) {
  if (!fromDate) return 0;
  const start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate.toISOString().slice(0, 10)}T00:00:00Z`);
  const ms = end - start;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

// POST /api/pt/exercises — log PT exercise
router.post('/exercises', auth, async (req, res) => {
  try {
    const { name, sets, reps, completed, date, notes } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });

    const id = uuidv4();
    const entryDate = date || new Date().toISOString().slice(0, 10);
    const createdAt = new Date().toISOString();

    await dbRun(
      `INSERT INTO pt_exercises (id, user_id, date, name, sets, reps, completed, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        req.user.id,
        entryDate,
        String(name).trim(),
        Number.isFinite(Number(sets)) ? Number(sets) : 3,
        Number.isFinite(Number(reps)) ? Number(reps) : 10,
        completed ? 1 : 0,
        notes || null,
        createdAt,
      ]
    );

    const exercise = await dbGet('SELECT * FROM pt_exercises WHERE id=?', [id]);
    res.status(201).json({ exercise });
  } catch (_) {
    res.status(500).json({ error: 'Failed to log PT exercise' });
  }
});

// PUT /api/pt/exercises/:id — update completion/details
router.put('/exercises/:id', auth, async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM pt_exercises WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!existing) return res.status(404).json({ error: 'Exercise not found' });

    const completed = req.body?.completed;
    const sets = req.body?.sets;
    const reps = req.body?.reps;
    const notes = req.body?.notes;

    await dbRun(
      `UPDATE pt_exercises
       SET completed=?, sets=?, reps=?, notes=?
       WHERE id=? AND user_id=?`,
      [
        completed === undefined ? existing.completed : (completed ? 1 : 0),
        sets === undefined ? existing.sets : Number(sets),
        reps === undefined ? existing.reps : Number(reps),
        notes === undefined ? existing.notes : notes,
        req.params.id,
        req.user.id,
      ]
    );

    const exercise = await dbGet('SELECT * FROM pt_exercises WHERE id=?', [req.params.id]);
    res.json({ exercise });
  } catch (_) {
    res.status(500).json({ error: 'Failed to update PT exercise' });
  }
});

// GET /api/pt/exercises — all PT exercises
router.get('/exercises', auth, async (req, res) => {
  try {
    const exercises = await dbAll(
      'SELECT * FROM pt_exercises WHERE user_id=? ORDER BY date DESC, created_at DESC',
      [req.user.id]
    );
    res.json({ exercises });
  } catch (_) {
    res.status(500).json({ error: 'Failed to fetch PT exercises' });
  }
});

// POST /api/pt/milestone — log milestone
router.post('/milestone', auth, async (req, res) => {
  try {
    const { type, date, notes } = req.body || {};
    if (!type || !ALLOWED_MILESTONES.has(type)) {
      return res.status(400).json({ error: 'Invalid milestone type' });
    }

    const milestoneDate = date || new Date().toISOString().slice(0, 10);

    // Keep one milestone row per type per user for clean timeline UX.
    const existing = await dbGet('SELECT * FROM pt_milestones WHERE user_id=? AND type=?', [req.user.id, type]);
    if (existing) {
      await dbRun('UPDATE pt_milestones SET date=?, notes=? WHERE id=? AND user_id=?', [milestoneDate, notes || null, existing.id, req.user.id]);
      const milestone = await dbGet('SELECT * FROM pt_milestones WHERE id=?', [existing.id]);
      return res.status(201).json({ milestone });
    }

    const id = uuidv4();
    await dbRun(
      `INSERT INTO pt_milestones (id, user_id, type, date, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [id, req.user.id, type, milestoneDate, notes || null]
    );

    const milestone = await dbGet('SELECT * FROM pt_milestones WHERE id=?', [id]);
    res.status(201).json({ milestone });
  } catch (_) {
    res.status(500).json({ error: 'Failed to log milestone' });
  }
});

// GET /api/pt/milestones — all milestones
router.get('/milestones', auth, async (req, res) => {
  try {
    const milestones = await dbAll('SELECT * FROM pt_milestones WHERE user_id=? ORDER BY date ASC, created_at ASC', [req.user.id]);
    res.json({ milestones });
  } catch (_) {
    res.status(500).json({ error: 'Failed to fetch milestones' });
  }
});

// GET /api/pt/readiness — readiness score from pain trend + days since injury
router.get('/readiness', auth, async (req, res) => {
  try {
    const logs = await dbAll('SELECT date, pain_level FROM injury_logs WHERE user_id=? ORDER BY date DESC', [req.user.id]);

    const latestInjuryDate = logs[0]?.date || null;
    const daysSinceInjury = toDayDiff(latestInjuryDate);
    const last7 = logs.slice(0, 7);
    const last3 = logs.slice(0, 3);

    const avgPain7 = last7.length ? last7.reduce((sum, row) => sum + Number(row.pain_level || 0), 0) / last7.length : 0;
    const avgPain3 = last3.length ? last3.reduce((sum, row) => sum + Number(row.pain_level || 0), 0) / last3.length : 0;

    const daysScore = clamp(daysSinceInjury * 2.2, 0, 40);
    const painScore = clamp(60 - (avgPain7 * 7), 0, 60);
    const trendBonus = avgPain3 <= avgPain7 ? 5 : -5;

    const score = clamp(Math.round(daysScore + painScore + trendBonus), 0, 100);

    res.json({
      score,
      days_since_injury: daysSinceInjury,
      avg_pain_3d: Number(avgPain3.toFixed(2)),
      avg_pain_7d: Number(avgPain7.toFixed(2)),
    });
  } catch (_) {
    res.status(500).json({ error: 'Failed to calculate readiness' });
  }
});

module.exports = router;
