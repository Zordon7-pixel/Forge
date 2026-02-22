const router = require('express').Router();
const auth = require('../middleware/auth');
const db = require('../db');

// GET /api/diagnostics — health check (any logged-in user)
router.get('/', auth, (req, res) => {
  const checks = [];

  // 1. DB integrity
  try {
    const result = db.prepare('PRAGMA integrity_check').get();
    checks.push({
      name: 'Database Integrity',
      ok: result.integrity_check === 'ok',
      detail: result.integrity_check,
    });
  } catch (e) {
    checks.push({ name: 'Database Integrity', ok: false, detail: e.message });
  }

  // 2. Required tables
  const requiredTables = ['users', 'runs', 'lifts', 'training_plans'];
  for (const t of requiredTables) {
    try {
      db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get();
      checks.push({ name: `Table: ${t}`, ok: true, detail: 'exists' });
    } catch (e) {
      checks.push({ name: `Table: ${t}`, ok: false, detail: 'missing' });
    }
  }

  // 3. Seed data
  try {
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    checks.push({ name: 'User Records', ok: userCount > 0, detail: `${userCount} user(s)` });
  } catch (e) {
    checks.push({ name: 'User Records', ok: false, detail: e.message });
  }

  // 4. Demo account exists
  try {
    const demo = db.prepare("SELECT id FROM users WHERE email = 'demo@forge.app'").get();
    checks.push({ name: 'Demo Account', ok: !!demo, detail: demo ? 'present' : 'missing' });
  } catch (e) {
    checks.push({ name: 'Demo Account', ok: false, detail: e.message });
  }

  res.json({ ok: checks.every((c) => c.ok), canHeal: checks.some((c) => !c.ok), checks });
});

// POST /api/diagnostics/heal — auto-fix
router.post('/heal', auth, async (req, res) => {
  const actions = [];

  // Re-seed if users missing
  try {
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    if (userCount === 0) {
      try {
        require('../db/seed').runSeed();
        actions.push('Re-seeded missing user data');
      } catch (e) {
        actions.push(`⚠️ Re-seed failed: ${e.message}`);
      }
    }
  } catch (e) {
    actions.push(`⚠️ User count check failed: ${e.message}`);
  }

  // VACUUM
  try {
    db.exec('VACUUM');
    actions.push('Database compacted');
  } catch (e) {}

  // Log to Control Room
  try {
    const actPath = '/Users/zordon/.openclaw/workspace/second-brain/data/activity.json';
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(actPath, 'utf8'));
    data.activity.push({
      id: `act-heal-${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: 'diagnostic',
      icon: '🔧',
      message: `FORGE self-heal ran: ${actions.length} action(s)`,
      detail: actions.join('; '),
    });
    fs.writeFileSync(actPath, JSON.stringify(data, null, 2));
  } catch (e) {}

  if (actions.length === 0) actions.push('No issues found — everything looks healthy');
  res.json({ ok: true, actions });
});

module.exports = router;
