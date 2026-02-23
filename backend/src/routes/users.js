const router = require('express').Router();
const { dbGet, dbRun } = require('../db');
const auth = require('../middleware/auth');

// GET /api/users/goal — get monthly goal setting
router.get('/goal', auth, async (req, res) => {
  try {
    const user = await dbGet('SELECT monthly_goal_miles, monthly_goal_mode FROM users WHERE id = ?', [req.user.id]);
    res.json({ miles: user?.monthly_goal_miles || null, mode: user?.monthly_goal_mode || 'auto' });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch goal' }); }
});

// PUT /api/users/goal — save monthly goal setting
router.put('/goal', auth, async (req, res) => {
  try {
    const { miles, mode } = req.body;
    await dbRun('UPDATE users SET monthly_goal_miles = ?, monthly_goal_mode = ? WHERE id = ?',
      [miles || null, mode || 'auto', req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to update goal' }); }
});

// GET /api/users/settings
router.get('/settings', auth, async (req, res) => {
  try {
    const user = await dbGet('SELECT distance_unit, theme, units FROM users WHERE id = ?', [req.user.id]);
    res.json({ distance_unit: user?.distance_unit || 'miles', theme: user?.theme || 'dark', units: user?.units || 'imperial' });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch settings' }); }
});

// PUT /api/users/settings
router.put('/settings', auth, async (req, res) => {
  try {
    const { distance_unit, theme, units } = req.body;
    await dbRun('UPDATE users SET distance_unit = ?, theme = ?, units = ? WHERE id = ?',
      [distance_unit || 'miles', theme || 'dark', units || 'imperial', req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to update settings' }); }
});

module.exports = router;
