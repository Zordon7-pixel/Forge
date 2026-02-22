const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// Get exercises for a muscle group
router.get('/', auth, (req, res) => {
  const { muscle_group } = req.query;
  let exercises;
  if (muscle_group) {
    exercises = db.prepare('SELECT * FROM exercises WHERE muscle_group = ? ORDER BY is_custom ASC, name ASC').all(muscle_group);
  } else {
    exercises = db.prepare('SELECT * FROM exercises ORDER BY muscle_group ASC, name ASC').all();
  }
  res.json({ exercises });
});

// Add a custom exercise (shared with all users)
router.post('/', auth, (req, res) => {
  const { name, muscle_group } = req.body;
  if (!name?.trim() || !muscle_group?.trim()) return res.status(400).json({ error: 'name and muscle_group required' });

  // Check if already exists
  const existing = db.prepare('SELECT id FROM exercises WHERE name = ? AND muscle_group = ?').get(name.trim(), muscle_group.trim());
  if (existing) return res.json({ exercise: existing, existed: true });

  const id = uuidv4();
  db.prepare('INSERT INTO exercises (id, name, muscle_group, is_custom, created_by) VALUES (?, ?, ?, 1, ?)')
    .run(id, name.trim(), muscle_group.trim(), req.user.id);
  const exercise = db.prepare('SELECT * FROM exercises WHERE id = ?').get(id);
  res.status(201).json({ exercise });
});

module.exports = router;
