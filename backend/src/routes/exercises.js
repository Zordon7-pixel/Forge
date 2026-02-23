const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

// GET /api/exercises — all or filter by muscle_group
router.get('/', auth, (req, res) => {
  const { muscle_group } = req.query;
  let exercises;
  if (muscle_group) {
    exercises = db.prepare(
      'SELECT * FROM exercises WHERE muscle_group=? AND approved=1 ORDER BY is_system DESC, name ASC'
    ).all(muscle_group.toLowerCase());
  } else {
    exercises = db.prepare(
      'SELECT * FROM exercises WHERE approved=1 ORDER BY muscle_group ASC, is_system DESC, name ASC'
    ).all();
  }
  res.json(exercises);
});

// POST /api/exercises — add custom exercise (shared with all users)
router.post('/', auth, (req, res) => {
  const { name, muscle_group, secondary_muscles = '', instructions = '' } = req.body;
  if (!name?.trim() || !muscle_group?.trim()) {
    return res.status(400).json({ error: 'Name and muscle group required' });
  }
  // Check for duplicate name (case-insensitive)
  const existing = db.prepare('SELECT id FROM exercises WHERE LOWER(name)=LOWER(?)').get(name.trim());
  if (existing) {
    return res.json({ message: 'Exercise already exists', id: existing.id, alreadyExists: true });
  }
  const id = require('crypto').randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO exercises (id, name, muscle_group, secondary_muscles, instructions, is_system, created_by_user_id, approved)
    VALUES (?, ?, ?, ?, ?, 0, ?, 1)
  `).run(id, name.trim(), muscle_group.toLowerCase().trim(), secondary_muscles.trim(), instructions.trim(), req.user.id);

  res.status(201).json({ id, name: name.trim(), muscle_group: muscle_group.toLowerCase(), is_system: 0, message: 'Exercise added to the community library!' });
});

// GET /api/exercises/:id — single exercise with full details
router.get('/:id', auth, (req, res) => {
  const exercise = db.prepare('SELECT * FROM exercises WHERE id=?').get(req.params.id);
  if (!exercise) return res.status(404).json({ error: 'Not found' });
  res.json(exercise);
});

module.exports = router;
