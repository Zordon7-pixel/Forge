const router = require('express').Router();
const { dbAll } = require('../db');
const auth = require('../middleware/auth');
const { requireDiagnosticsAdmin } = require('./diagnostics');

const REPORT_STATUSES = new Set(['open', 'reviewed', 'closed']);

router.get('/', auth, requireDiagnosticsAdmin, async (req, res) => {
  const requestedStatus = String(req.query.status || 'open');
  const status = REPORT_STATUSES.has(requestedStatus) ? requestedStatus : 'open';
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  try {
    const reports = await dbAll(
      `SELECT r.id, r.category, r.context_type, r.context_id, r.note, r.status,
              r.created_at, r.reviewed_at,
              r.reporter_id, reporter.name AS reporter_name, reporter.email AS reporter_email,
              r.subject_user_id, subject.name AS subject_name, subject.email AS subject_email
       FROM social_reports r
       LEFT JOIN users reporter ON reporter.id = r.reporter_id
       LEFT JOIN users subject ON subject.id = r.subject_user_id
       WHERE r.status = ?
       ORDER BY r.created_at DESC
       LIMIT ?`,
      [status, limit]
    );
    res.json({ reports });
  } catch (err) {
    console.error('[admin/social-reports] list failed:', err.message);
    res.status(500).json({ error: 'Could not load social reports.' });
  }
});

module.exports = router;
