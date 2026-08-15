const router = require('express').Router();
const auth = require('../middleware/auth');
const { randomUUID } = require('node:crypto');
const { pool, dbGet, dbAll, withTransaction } = require('../db');
const plansRouter = require('./plans');
const { RACE_PLAN_POLICY_V1 } = require('../lib/racePlanPolicy');
const {
  buildDecisionArtifactDiagnosticBundle,
  buildGoalBackwardReleaseDiagnosticBundle,
  buildPlanDiagnosticBundle,
} = require('../lib/racePlanDiagnostics');
const {
  goalBackwardReleaseTelemetrySnapshot,
} = require('../lib/betaPlanRollout');

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

// POST /api/diagnostics/plan-audit — one owner-scoped, no-write plan shadow.
router.post('/plan-audit', auth, requireDiagnosticsAdmin, async (req, res) => {
  const targetUserId = typeof req.body?.user_id === 'string' ? req.body.user_id.trim() : '';
  if (!targetUserId || targetUserId.length > 128) {
    return res.status(400).json({ error: 'A valid user_id target is required.' });
  }

  try {
    const planningDate = typeof req.body?.planning_date_local === 'string'
      ? req.body.planning_date_local.trim()
      : new Date().toISOString().slice(0, 10);
    let raceIds = Array.isArray(req.body?.race_ids)
      ? req.body.race_ids.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    if (raceIds.length === 0) {
      const races = await dbAll(
        `SELECT id FROM race_events
         WHERE user_id=? AND status='upcoming' AND race_date>=?
         ORDER BY race_date ASC LIMIT 2`,
        [targetUserId, planningDate]
      );
      raceIds = races.map((race) => race.id);
    }
    if (raceIds.length < 1 || raceIds.length > 2) {
      return res.status(409).json({ error: 'The target needs one or two future owned races for this audit.' });
    }

    const candidate = await plansRouter._test.previewPlanForUser(targetUserId, {
      race_ids: raceIds,
      target: req.body?.target || {},
      planning_date_local: planningDate,
      timezone_offset_minutes: Number(req.body?.timezone_offset_minutes || 0),
    }, { store: false });
    const bundle = buildPlanDiagnosticBundle({ targetUserId, candidate });

    await withTransaction(async (tx) => {
      await tx.run(
        `DELETE FROM diagnostic_access_audit
         WHERE created_at < CURRENT_TIMESTAMP - (?::integer * INTERVAL '1 day')
           AND (actor_user_id=? OR target_user_id=?)`,
        [RACE_PLAN_POLICY_V1.diagnostics.retentionDays, req.user.id, targetUserId]
      );
      await tx.run(
        `INSERT INTO diagnostic_access_audit (
           id, actor_user_id, target_user_id, training_plan_id, user_plan_id, candidate_id, action
         ) VALUES (?,?,?,?,?,?,?)`,
        [
          randomUUID(),
          req.user.id,
          targetUserId,
          bundle.active_plan.training_plan_id,
          bundle.active_plan.user_plan_id,
          bundle.candidate.id,
          'plan_shadow_audit',
        ]
      );
    }, {
      userIds: [req.user.id, targetUserId],
      requireUserIds: [req.user.id, targetUserId],
    });

    return res.json({ ok: true, diagnostic: bundle });
  } catch (err) {
    console.error('[diagnostics/plan-audit] failed:', err.message);
    return res.status(Number(err.status) || 500).json({
      error: Number(err.status) && Number(err.status) < 500
        ? err.message
        : 'Unable to build the plan diagnostic.',
      ...(err.code ? { code: err.code } : {}),
    });
  }
});

// GET /api/diagnostics/plan-audit/:decisionId/artifacts — bounded, owner-scoped
// v2.4 pipeline artifacts. Payload validation fails closed on secret/PII keys.
router.get('/plan-audit/:decisionId/artifacts', auth, requireDiagnosticsAdmin, async (req, res) => {
  const targetUserId = typeof req.query?.user_id === 'string' ? req.query.user_id.trim() : '';
  const decisionId = typeof req.params?.decisionId === 'string' ? req.params.decisionId.trim() : '';
  if (!targetUserId || targetUserId.length > 128 || !decisionId || decisionId.length > 200) {
    return res.status(400).json({ error: 'A valid user_id target and decision ID are required.' });
  }

  try {
    const artifacts = await dbAll(
      `SELECT id, user_id, artifact_kind, decision_id, parent_artifact_id,
              plan_generation_candidate_id, schema_version, policy_version,
              revision, content_hash, payload_json, created_at
       FROM planning_pipeline_artifacts
       WHERE user_id=? AND decision_id=?
       ORDER BY created_at ASC, id ASC
       LIMIT 32`,
      [targetUserId, decisionId]
    );
    if (!artifacts.length) return res.status(404).json({ error: 'No linked artifacts were found for that decision.' });

    const bundle = buildDecisionArtifactDiagnosticBundle({
      targetUserId,
      decisionId,
      artifactRows: artifacts,
    });
    await withTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO diagnostic_access_audit (
           id, actor_user_id, target_user_id, training_plan_id, user_plan_id, candidate_id, action
         ) VALUES (?,?,?,?,?,?,?)`,
        [
          randomUUID(),
          req.user.id,
          targetUserId,
          null,
          null,
          artifacts.find((artifact) => artifact.plan_generation_candidate_id)?.plan_generation_candidate_id || null,
          'planning_artifacts_read',
        ]
      );
    }, {
      userIds: [req.user.id, targetUserId],
      requireUserIds: [req.user.id, targetUserId],
    });
    return res.json({ ok: true, diagnostic: bundle });
  } catch (err) {
    console.error('[diagnostics/plan-artifacts] failed:', err.message);
    return res.status(Number(err.status) || 500).json({
      error: Number(err.status) && Number(err.status) < 500
        ? err.message
        : 'Unable to retrieve the linked plan artifacts.',
      ...(err.code ? { code: err.code } : {}),
    });
  }
});

// GET /api/diagnostics/goal-backward-release — process-local, bounded release
// counters. Records contain pseudonymous refs internally; this projection omits
// even those refs and exposes only closed dimensions and integer counts.
router.get('/goal-backward-release', auth, requireDiagnosticsAdmin, (_req, res) => {
  try {
    const diagnostic = buildGoalBackwardReleaseDiagnosticBundle({
      telemetry: goalBackwardReleaseTelemetrySnapshot(),
    });
    return res.json({ ok: true, diagnostic });
  } catch (err) {
    return res.status(Number(err.status) || 500).json({
      error: 'Unable to retrieve goal-backward release diagnostics.',
      ...(err.code ? { code: err.code } : {}),
    });
  }
});

router.requireDiagnosticsAdmin = requireDiagnosticsAdmin;

module.exports = router;
