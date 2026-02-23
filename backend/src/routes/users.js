const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

// GET /api/users/goal — get monthly goal setting
router.get('/goal', auth, (req, res) => {
  // Ensure columns exist
  try { db.exec('ALTER TABLE users ADD COLUMN monthly_goal_miles REAL') } catch(_) {}
  try { db.exec('ALTER TABLE users ADD COLUMN monthly_goal_mode TEXT DEFAULT \'auto\'') } catch(_) {}
  
  const user = db.prepare('SELECT monthly_goal_miles, monthly_goal_mode FROM users WHERE id = ?').get(req.user.id);
  res.json({ miles: user?.monthly_goal_miles || null, mode: user?.monthly_goal_mode || 'auto' });
});

// PUT /api/users/goal — save monthly goal setting
router.put('/goal', auth, (req, res) => {
  // Ensure columns exist
  try { db.exec('ALTER TABLE users ADD COLUMN monthly_goal_miles REAL') } catch(_) {}
  try { db.exec('ALTER TABLE users ADD COLUMN monthly_goal_mode TEXT DEFAULT \'auto\'') } catch(_) {}
  
  const { miles, mode } = req.body;
  db.prepare('UPDATE users SET monthly_goal_miles = ?, monthly_goal_mode = ? WHERE id = ?')
    .run(miles || null, mode || 'auto', req.user.id);
  res.json({ ok: true });
});

// GET /api/users/settings
router.get('/settings', auth, (req, res) => {
  try { db.exec("ALTER TABLE users ADD COLUMN distance_unit TEXT DEFAULT 'miles'") } catch(_) {}
  try { db.exec("ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'dark'") } catch(_) {}
  try { db.exec("ALTER TABLE users ADD COLUMN units TEXT DEFAULT 'imperial'") } catch(_) {}
  const user = db.prepare('SELECT distance_unit, theme, units FROM users WHERE id = ?').get(req.user.id)
  res.json({ distance_unit: user?.distance_unit || 'miles', theme: user?.theme || 'dark', units: user?.units || 'imperial' })
})

// PUT /api/users/settings
router.put('/settings', auth, (req, res) => {
  try { db.exec("ALTER TABLE users ADD COLUMN distance_unit TEXT DEFAULT 'miles'") } catch(_) {}
  try { db.exec("ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'dark'") } catch(_) {}
  try { db.exec("ALTER TABLE users ADD COLUMN units TEXT DEFAULT 'imperial'") } catch(_) {}
  const { distance_unit, theme, units } = req.body
  db.prepare("UPDATE users SET distance_unit = ?, theme = ?, units = ? WHERE id = ?").run(
    distance_unit || 'miles',
    theme || 'dark',
    units || 'imperial',
    req.user.id
  )
  res.json({ ok: true })
})

module.exports = router;
