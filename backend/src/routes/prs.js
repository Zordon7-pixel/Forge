const router = require('express').Router();
const { dbGet, dbAll, dbRun, withUserMutation } = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const autoUpdatePRs = require('../services/prAuto');
const { isRunActivity, runActivitySql } = require('../lib/runActivity');

const { STANDARD_TIME_PRS, nearestStandardTimePr, timePrLabel: manualTimePrLabel } = autoUpdatePRs;

function standardTimePrForDistance(value) {
  const miles = Number(value);
  if (!Number.isFinite(miles)) return null;
  return STANDARD_TIME_PRS.find((item) => Math.abs(item.target - miles) <= 0.002) || null;
}

function legacyManualTimePrLabel(distance) {
  return `Time PR (${distance.target}mi)`;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  const today = new Date().toISOString().slice(0, 10);
  return value <= today ? value : null;
}

// GET /api/prs — get all PRs for user
router.get('/', auth, async (req, res) => {
  try {
    const prs = await dbAll(`SELECT * FROM personal_records WHERE user_id = ? ORDER BY category, achieved_at DESC`, [req.user.id]);
    res.json({ prs });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch PRs' }); }
});

// POST /api/prs — add a PR manually
router.post('/', auth, async (req, res) => {
  try {
    const { category, label, value, unit, notes, achieved_at } = req.body;
    if (!category || !label || value == null || !unit) return res.status(400).json({ error: 'Missing fields' });
    const id = uuidv4();
    await dbRun(
      `INSERT INTO personal_records (id, user_id, category, label, value, unit, notes, achieved_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
      [id, req.user.id, category, label, Number(value), unit, notes || null, achieved_at || new Date().toISOString().slice(0, 10)]
    );
    const pr = await dbGet('SELECT * FROM personal_records WHERE id = ? AND user_id = ?', [id, req.user.id]);
    res.json(pr);
  } catch (err) { res.status(500).json({ error: 'Failed to add PR' }); }
});

// DELETE /api/prs/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const pr = await dbGet('SELECT * FROM personal_records WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!pr) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM personal_records WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

// POST /api/prs/auto-detect — called after a run is saved, auto-detects new PRs
router.post('/auto-detect', auth, async (req, res) => {
  try {
    const newPRs = await withUserMutation(req.user.id, async (tx) => {
      const { get: dbGet, run: dbRun } = tx;
      const { run_id } = req.body;
      const run = run_id ? await dbGet('SELECT * FROM runs WHERE id = ? AND user_id = ?', [run_id, req.user.id]) : null;
      const detected = run ? await autoUpdatePRs(req.user.id, run, { tx, strictErrors: true }) : { newPRs: [] };
      const newPRs = [];
      for (const label of detected.newPRs) {
        const pr = await dbGet('SELECT label, value, unit FROM personal_records WHERE user_id=? AND label=? AND source=?',
          [req.user.id, label, 'auto']);
        if (pr) newPRs.push(pr);
      }

      if (run && isRunActivity(run) && run.distance_miles && run.duration_seconds) {
        // Check longest run
        const longestRun = await dbGet(`SELECT MAX(distance_miles) as max FROM runs WHERE user_id = ? AND id != ? AND ${runActivitySql()}`, [req.user.id, run.id]);
        if (!longestRun.max || run.distance_miles > longestRun.max) {
          const existing = await dbGet(`SELECT * FROM personal_records WHERE user_id = ? AND category = 'run' AND label = 'Longest Run'`, [req.user.id]);
          if (!existing || (existing.source === 'auto' && run.distance_miles > existing.value)) {
            if (existing) await dbRun('DELETE FROM personal_records WHERE id = ? AND user_id = ?', [existing.id, req.user.id]);
            const id = uuidv4();
            await dbRun(
              `INSERT INTO personal_records (id, user_id, category, label, value, unit, run_id, achieved_at) VALUES (?, ?, 'run', 'Longest Run', ?, 'mi', ?, ?)`,
              [id, req.user.id, run.distance_miles, run.id, run.date || new Date().toISOString().slice(0, 10)]
            );
            newPRs.push({ label: 'Longest Run', value: run.distance_miles, unit: 'mi' });
          }
        }

        // Check fastest pace
        const pace = run.duration_seconds / 60 / run.distance_miles;
        const fastestPace = await dbGet(
          `SELECT MIN(duration_seconds / 60.0 / distance_miles) as min FROM runs WHERE user_id = ? AND distance_miles > 0 AND duration_seconds > 0 AND id != ? AND ${runActivitySql()}`,
          [req.user.id, run.id]
        );
        if (!fastestPace.min || pace < fastestPace.min) {
          const existing = await dbGet(`SELECT * FROM personal_records WHERE user_id = ? AND category = 'run' AND label = 'Fastest Pace'`, [req.user.id]);
          if (!existing || (existing.source === 'auto' && pace < existing.value)) {
            if (existing) await dbRun('DELETE FROM personal_records WHERE id = ? AND user_id = ?', [existing.id, req.user.id]);
            const id = uuidv4();
            await dbRun(
              `INSERT INTO personal_records (id, user_id, category, label, value, unit, run_id, achieved_at) VALUES (?, ?, 'run', 'Fastest Pace', ?, 'min/mi', ?, ?)`,
              [id, req.user.id, pace, run.id, run.date || new Date().toISOString().slice(0, 10)]
            );
            newPRs.push({ label: 'Fastest Pace', value: pace, unit: 'min/mi' });
          }
        }
      }

      return newPRs;
    }, { userLock: 'update' });
    res.json({ newPRs });
  } catch (err) { res.status(500).json({ error: 'Auto-detect failed' }); }
});

// GET /api/prs/time — manual override, persisted auto, then observed legacy run (±1%).
router.get('/time', auth, async (req, res) => {
  try {
    const [persistedRows, candidateRuns] = await Promise.all([
      dbAll(
        `SELECT id, label, value, achieved_at, source, run_id
         FROM personal_records
         WHERE user_id=? AND category='time_pr'
         ORDER BY achieved_at DESC, id DESC`,
        [req.user.id]
      ),
      dbAll(
        `SELECT id, distance_miles, duration_seconds, date
         FROM runs
         WHERE user_id=? AND distance_miles>=? AND distance_miles<=?
           AND duration_seconds>0 AND ${runActivitySql()}`,
        [req.user.id, STANDARD_TIME_PRS[0].min, STANDARD_TIME_PRS[STANDARD_TIME_PRS.length - 1].max]
      ),
    ]);
    const classifiedRuns = candidateRuns
      .map((run) => ({ run, distance: nearestStandardTimePr(run.distance_miles) }))
      .filter(({ distance }) => distance);
    const results = STANDARD_TIME_PRS.map(dist => {
      const records = persistedRows.filter(row => (
        row.label === manualTimePrLabel(dist) || row.label === legacyManualTimePrLabel(dist)
      ) && Number.isFinite(Number(row.value)) && Number(row.value) > 0);
      // Older manual writes inherited source='auto'; their absent run link
      // still identifies the existing manual override, never an automatic time.
      const manual = records.find(row => row.source === 'manual' || !row.run_id);
      const manualSeconds = Number(manual?.value);
      if (manual && Number.isFinite(manualSeconds) && manualSeconds > 0) {
        return {
          distance: dist.label,
          best_time_seconds: manualSeconds,
          pace: manualSeconds / dist.target,
          date: manual.achieved_at,
          run_id: null,
          manual_record_id: manual.id,
          is_manual: true,
        };
      }
      const persisted = records.find(row => row.source === 'auto' && row.run_id);
      if (persisted) {
        const observedRun = candidateRuns.find(run => run.id === persisted.run_id);
        return {
          distance: dist.label,
          best_time_seconds: Number(persisted.value),
          pace: Number(persisted.value) / (observedRun?.distance_miles || dist.target),
          date: persisted.achieved_at,
          run_id: persisted.run_id,
          observed_distance_miles: observedRun?.distance_miles ?? null,
          observed_time_seconds: Number(persisted.value),
          is_manual: false,
        };
      }
      const run = classifiedRuns
        .filter(({ distance, run }) => distance.label === dist.label
          && Number.isFinite(Number(run.duration_seconds)) && Number(run.duration_seconds) > 0)
        .map(({ run: classifiedRun }) => classifiedRun)
        .sort((left, right) => Number(left.duration_seconds) - Number(right.duration_seconds)
          || String(left.date).localeCompare(String(right.date)) || String(left.id).localeCompare(String(right.id)))[0];
      if (!run) return { distance: dist.label, best_time_seconds: null, pace: null, date: null, run_id: null, is_manual: false };
      return {
        distance: dist.label,
        best_time_seconds: Number(run.duration_seconds),
        pace: run.duration_seconds / run.distance_miles,
        date: run.date,
        run_id: run.id,
        observed_distance_miles: run.distance_miles,
        observed_time_seconds: run.duration_seconds,
        is_manual: false,
      };
    });

    res.json({ times: results });
  } catch (err) {
    console.error('[prs/time] fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch PR times' });
  }
});

// POST /api/prs/manual — save a manually entered PR (time-based)
router.post('/manual', auth, async (req, res) => {
  const { distance_miles, time_seconds, date } = req.body || {};
  const distance = standardTimePrForDistance(distance_miles);
  const seconds = Number(time_seconds);
  const achievedAt = validDate(date || new Date().toISOString().slice(0, 10));
  if (!distance) return res.status(400).json({ error: 'Choose a supported race distance' });
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 604800) {
    return res.status(400).json({ error: 'time_seconds must be a positive whole number' });
  }
  if (!achievedAt) return res.status(400).json({ error: 'Enter a valid date that is not in the future' });

  try {
    const pr = await withUserMutation(req.user.id, async (tx) => {
      const canonicalLabel = manualTimePrLabel(distance);
      const legacyLabel = legacyManualTimePrLabel(distance);
      const existing = await tx.get(
        `SELECT id FROM personal_records
         WHERE user_id=? AND category='time_pr' AND (label=? OR label=?)
           AND (source='manual' OR (run_id IS NULL AND notes='Manually entered'))
         ORDER BY achieved_at DESC LIMIT 1 FOR UPDATE`,
        [req.user.id, canonicalLabel, legacyLabel]
      );
      const id = existing?.id || uuidv4();
      if (existing) {
        const result = await tx.run(
          `UPDATE personal_records
           SET label=?, value=?, unit='seconds', notes='Manually entered', achieved_at=?, source='manual', run_id=NULL
           WHERE id=? AND user_id=?`,
          [canonicalLabel, seconds, achievedAt, id, req.user.id]
        );
        if (result.changes !== 1) throw new Error('Manual time PR update lost ownership');
      } else {
        await tx.run(
          `INSERT INTO personal_records (id, user_id, category, label, value, unit, notes, achieved_at, source)
           VALUES (?, ?, 'time_pr', ?, ?, 'seconds', 'Manually entered', ?, 'manual')`,
          [id, req.user.id, canonicalLabel, seconds, achievedAt]
        );
      }
      return tx.get('SELECT * FROM personal_records WHERE id=? AND user_id=?', [id, req.user.id]);
    }, { userLock: 'update' });
    res.json(pr);
  } catch (err) {
    console.error('[prs/manual] save failed:', err.message);
    res.status(500).json({ error: 'Failed to save manual PR' });
  }
});

module.exports = router;
module.exports._test = {
  STANDARD_TIME_PRS,
  standardTimePrForDistance,
  nearestStandardTimePr,
  manualTimePrLabel,
  legacyManualTimePrLabel,
  validDate,
};
