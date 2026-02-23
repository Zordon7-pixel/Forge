const router = require('express').Router();
const { dbGet, dbRun } = require('../db');
const auth = require('../middleware/auth');

// POST /api/checkin — daily life check-in
router.post('/', auth, async (req, res) => {
  try {
    const { feeling, time_available, life_flags = [] } = req.body;
    const today = new Date().toISOString().slice(0,10);

    const existing = await dbGet('SELECT id FROM daily_checkins WHERE user_id=? AND checkin_date=?', [req.user.id, today]);
    if (existing) {
      await dbRun('UPDATE daily_checkins SET feeling=?, time_available=?, life_flags=? WHERE id=?',
        [feeling, time_available, JSON.stringify(life_flags), existing.id]);
    } else {
      const id = require('crypto').randomBytes(8).toString('hex');
      await dbRun(
        'INSERT INTO daily_checkins (id, user_id, checkin_date, feeling, time_available, life_flags) VALUES (?,?,?,?,?,?)',
        [id, req.user.id, today, feeling, time_available, JSON.stringify(life_flags)]
      );
    }

    const feelingLabels = ['', 'Exhausted', 'Tired', 'Okay', 'Good', 'Great'];
    const msgs = [];
    if (feeling <= 2) msgs.push('low energy');
    if (time_available <= 30) msgs.push('limited time');
    if (life_flags.includes('long_shift')) msgs.push('long work shift');
    if (life_flags.includes('sick')) msgs.push('not feeling well');
    if (life_flags.includes('sore')) msgs.push('soreness');
    if (life_flags.includes('traveling')) msgs.push('traveling');

    let adjustment = null;
    if (msgs.length > 0) {
      const context = msgs.join(', ');
      if (feeling <= 2 || life_flags.includes('sick')) {
        adjustment = `Given your ${context}, I've adjusted today to a recovery session. Rest is training too.`;
      } else if (time_available <= 30) {
        adjustment = `Only ${time_available} minutes today — I've got a focused ${time_available}-minute session ready for you.`;
      } else if (life_flags.includes('long_shift')) {
        adjustment = `Long day at work noted. I've shortened today's session and moved intensity to when you're fresher.`;
      } else {
        adjustment = `Noted: ${context}. Plan adjusted accordingly. You've got this.`;
      }
    }

    res.json({ ok: true, adjustment, feeling: feelingLabels[feeling] || 'Noted' });
  } catch (err) { res.status(500).json({ error: 'Check-in failed' }); }
});

router.get('/today', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const checkin = await dbGet('SELECT * FROM daily_checkins WHERE user_id=? AND checkin_date=?', [req.user.id, today]);
    res.json(checkin || null);
  } catch(e) { res.json(null); }
});

module.exports = router;
