const router = require('express').Router();
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');

// GET /api/exercises — all or filter by muscle_group
router.get('/', auth, async (req, res) => {
  try {
    const { muscle_group } = req.query;
    let exercises;
    if (muscle_group) {
      exercises = await dbAll(
        'SELECT * FROM exercises WHERE muscle_group=? AND approved=1 ORDER BY is_system DESC, name ASC',
        [muscle_group.toLowerCase()]
      );
    } else {
      exercises = await dbAll(
        'SELECT * FROM exercises WHERE approved=1 ORDER BY muscle_group ASC, is_system DESC, name ASC'
      );
    }
    res.json(exercises);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch exercises' }); }
});

// POST /api/exercises — add custom exercise (shared with all users)
router.post('/', auth, async (req, res) => {
  try {
    const { name, muscle_group, secondary_muscles = '', instructions = '' } = req.body;
    if (!name?.trim() || !muscle_group?.trim()) return res.status(400).json({ error: 'Name and muscle group required' });
    const existing = await dbGet('SELECT id FROM exercises WHERE LOWER(name)=LOWER(?)', [name.trim()]);
    if (existing) return res.json({ message: 'Exercise already exists', id: existing.id, alreadyExists: true });
    const id = require('crypto').randomBytes(8).toString('hex');
    await dbRun(
      `INSERT INTO exercises (id, name, muscle_group, secondary_muscles, instructions, is_system, created_by_user_id, approved)
       VALUES (?, ?, ?, ?, ?, 0, ?, 1)`,
      [id, name.trim(), muscle_group.toLowerCase().trim(), secondary_muscles.trim(), instructions.trim(), req.user.id]
    );
    res.status(201).json({ id, name: name.trim(), muscle_group: muscle_group.toLowerCase(), is_system: 0, message: 'Exercise added to the community library!' });
  } catch (err) { res.status(500).json({ error: 'Failed to add exercise' }); }
});

// GET /api/exercises/:id — single exercise with full details
router.get('/:id', auth, async (req, res) => {
  try {
    const exercise = await dbGet('SELECT * FROM exercises WHERE id=?', [req.params.id]);
    if (!exercise) return res.status(404).json({ error: 'Not found' });
    res.json(exercise);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch exercise' }); }
});

module.exports = router;
