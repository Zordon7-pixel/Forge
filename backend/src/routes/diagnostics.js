const router = require('express').Router();
const auth = require('../middleware/auth');
const { pool, dbGet, dbAll } = require('../db');

function diagnosticsAdmins() {
  return String(process.env.DIAGNOSTICS_ADMIN_EMAILS || process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

function requireDiagnosticsAdmin(req, res, next) {
  const admins = diagnosticsAdmins();
  const email = String(req.user?.email || '').toLowerCase();
  if (email === 'demo@forge.app' && process.env.DIAGNOSTICS_ALLOW_DEMO_ADMIN !== 'true') {
    return res.status(403).json({ error: 'Diagnostics are restricted to admins.' });
  }
  if (admins.length > 0 && admins.includes(email)) return next();
  return res.status(403).json({ error: 'Diagnostics are restricted to admins.' });
}

// GET /api/diagnostics — health check (admin only)
router.get('/', auth, requireDiagnosticsAdmin, async (req, res) => {
  const checks = [];

  // 1. DB connection check (replaces SQLite PRAGMA integrity_check)
  try {
    await pool.query('SELECT 1');
    checks.push({ name: 'Database Integrity', ok: true, detail: 'connected' });
  } catch (e) {
    checks.push({ name: 'Database Integrity', ok: false, detail: e.message });
  }

  // 2. Required tables
  const requiredTables = ['users', 'runs', 'lifts', 'training_plans'];
  for (const t of requiredTables) {
    try {
      await pool.query(`SELECT 1 FROM ${t} LIMIT 1`);
      checks.push({ name: `Table: ${t}`, ok: true, detail: 'exists' });
    } catch (e) {
      checks.push({ name: `Table: ${t}`, ok: false, detail: 'missing' });
    }
  }

  // 3. Seed data
  try {
    const row = await dbGet('SELECT COUNT(*) as c FROM users');
    const userCount = Number(row?.c || 0);
    checks.push({ name: 'User Records', ok: userCount > 0, detail: `${userCount} user(s)` });
  } catch (e) {
    checks.push({ name: 'User Records', ok: false, detail: e.message });
  }

  // 4. Demo account exists
  try {
    const demo = await dbGet("SELECT id FROM users WHERE email = 'demo@forge.app'");
    checks.push({ name: 'Demo Account', ok: !!demo, detail: demo ? 'present' : 'missing' });
  } catch (e) {
    checks.push({ name: 'Demo Account', ok: false, detail: e.message });
  }

  res.json({ ok: checks.every((c) => c.ok), canHeal: checks.some((c) => !c.ok), checks });
});

// POST /api/diagnostics/heal — auto-fix (admin only)
router.post('/heal', auth, requireDiagnosticsAdmin, async (req, res) => {
  const actions = [];

  // Re-seed if users missing
  try {
    const row = await dbGet('SELECT COUNT(*) as c FROM users');
    const userCount = Number(row?.c || 0);
    if (userCount === 0) {
      try {
        await require('../db/seed').runSeed();
        actions.push('Re-seeded missing user data');
      } catch (e) {
        actions.push(`⚠️ Re-seed failed: ${e.message}`);
      }
    }
  } catch (e) {
    actions.push(`⚠️ User count check failed: ${e.message}`);
  }

  if (actions.length === 0) actions.push('No issues found — everything looks healthy');
  res.json({ ok: true, actions });
});

router.requireDiagnosticsAdmin = requireDiagnosticsAdmin;

module.exports = router;
