const { dbGet, dbAll, dbRun } = require('../db');
const { v4: uuidv4 } = require('uuid');
const { isRunActivity, runActivitySql } = require('../lib/runActivity');

const RACE_WINDOWS = [
  { label: '1 Mile PR', miles: 1.0 },
  { label: '5K PR', miles: 3.107 },
  { label: '10K PR', miles: 6.214 },
  { label: '15K PR', miles: 9.321 },
  { label: '10 Mile PR', miles: 10.0 },
  { label: 'Half Marathon PR', miles: 13.109 },
  { label: 'Marathon PR', miles: 26.219 },
];

const DISTANCE_TOLERANCE = 0.05;

function formatDate(date) {
  if (!date) return new Date().toISOString().slice(0, 10);
  return date;
}

function isBetter(newValue, oldValue, direction = 'lower') {
  if (oldValue == null) return true;
  if (direction === 'higher') return newValue > oldValue;
  return newValue < oldValue;
}

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function getDb(options = {}) {
  const tx = options.tx || null;
  return {
    get: tx?.get || dbGet,
    all: tx?.all || dbAll,
    run: tx?.run || dbRun,
  };
}

function getCandidateDirection(label) {
  if (label === 'Longest Run') return 'higher';
  return 'lower';
}

function buildRunPrCandidates(run) {
  if (!run || !isRunActivity(run)) return [];
  const distance = Number(run.distance_miles || 0);
  const durationSeconds = Number(run.duration_seconds || 0);

  if (!distance || !durationSeconds) return [];

  const pacePerMile = durationSeconds > 0 && distance > 0
    ? (durationSeconds / 60) / distance
    : null;

  const candidates = [];

  if (pacePerMile) {
    candidates.push({ label: 'Best Avg Pace', value: round(pacePerMile), unit: 'min/mi', direction: 'lower' });
  }

  if (distance >= 0.95 && distance <= 1.2 && pacePerMile) {
    candidates.push({ label: 'Fastest Mile', value: round(pacePerMile), unit: 'min/mi', direction: 'lower' });
  }

  if (distance > 0) {
    candidates.push({ label: 'Longest Run', value: round(distance, 2), unit: 'mi', direction: 'higher' });
  }

  if (pacePerMile) {
    const closestRace = RACE_WINDOWS
      .map((race) => ({ ...race, diffRatio: Math.abs(distance - race.miles) / race.miles }))
      .filter((race) => race.diffRatio <= DISTANCE_TOLERANCE)
      .sort((left, right) => left.diffRatio - right.diffRatio)[0];
    if (closestRace) {
      candidates.push({ label: closestRace.label, value: round(pacePerMile), unit: 'min/mi', direction: 'lower' });
    }
  }

  return candidates;
}

async function autoUpdatePRs(userId, run, options = {}) {
  const result = { newPRs: [], discrepancies: [] };
  if (!run || !userId) return result;
  const db = getDb(options);

  const runDate = formatDate(run.date);
  const candidates = buildRunPrCandidates(run);

  for (const candidate of candidates) {
    if (candidate.value == null) continue;
    try {
      const existing = await db.get(
        `SELECT * FROM personal_records WHERE user_id = ? AND category = 'run' AND label = ?`,
        [userId, candidate.label]
      );

      if (!existing) {
        const id = uuidv4();
        await db.run(
          `INSERT INTO personal_records (id, user_id, category, label, value, unit, run_id, achieved_at, source, discrepancy, auto_value) VALUES (?, ?, 'run', ?, ?, ?, ?, ?, 'auto', 0, NULL)`,
          [id, userId, candidate.label, candidate.value, candidate.unit, run.id, runDate]
        );
        result.newPRs.push(candidate.label);
        continue;
      }

      if (existing.source === 'auto') {
        if (isBetter(candidate.value, Number(existing.value), candidate.direction)) {
          await db.run(
            `UPDATE personal_records SET value = ?, unit = ?, run_id = ?, achieved_at = ?, discrepancy = 0, auto_value = NULL, source = 'auto' WHERE id = ? AND user_id = ?`,
            [candidate.value, candidate.unit, run.id, runDate, existing.id, userId]
          );
          result.newPRs.push(candidate.label);
        }
        continue;
      }

      if (existing.source === 'manual' && isBetter(candidate.value, Number(existing.value), candidate.direction)) {
        await db.run(
          `UPDATE personal_records SET discrepancy = 1, auto_value = ? WHERE id = ? AND user_id = ?`,
          [candidate.value, existing.id, userId]
        );
        result.discrepancies.push({
          label: candidate.label,
          auto_value: candidate.value,
          manual_value: existing.value,
        });
      }
    } catch (err) {
      console.error('PR auto-detect error for', candidate.label, err.message);
    }
  }

  return result;
}

async function recomputeRunPrCategories(userId, categoryLabels = [], options = {}) {
  if (!userId) return { recomputed: [], removed: [] };
  const labels = [...new Set((categoryLabels || []).filter(Boolean))];
  const result = { recomputed: [], removed: [] };
  if (!labels.length) return result;
  const db = getDb(options);
  const runs = await db.all(
    `SELECT * FROM runs WHERE user_id=? AND ${runActivitySql()} ORDER BY date ASC, created_at ASC`,
    [userId]
  );

  for (const label of labels) {
    const autoPr = await db.get(
      `SELECT * FROM personal_records WHERE user_id=? AND category='run' AND label=? AND source='auto'`,
      [userId, label]
    );
    if (!autoPr) continue;

    const direction = getCandidateDirection(label);
    let best = null;
    for (const run of runs) {
      const candidate = buildRunPrCandidates(run).find((item) => item.label === label);
      if (!candidate || candidate.value == null) continue;
      if (!best || isBetter(candidate.value, best.value, direction)) {
        best = {
          ...candidate,
          run,
          achieved_at: formatDate(run.date),
        };
      }
    }

    if (!best) {
      await db.run('DELETE FROM personal_records WHERE id=? AND user_id=? AND source=\'auto\'', [autoPr.id, userId]);
      result.removed.push(label);
      continue;
    }

    await db.run(
      `UPDATE personal_records
       SET value=?, unit=?, run_id=?, achieved_at=?, discrepancy=0, auto_value=NULL, source='auto'
       WHERE id=? AND user_id=? AND source='auto'`,
      [best.value, best.unit, best.run.id, best.achieved_at, autoPr.id, userId]
    );
    result.recomputed.push(label);
  }

  return result;
}

autoUpdatePRs.recomputeRunPrCategories = recomputeRunPrCategories;
autoUpdatePRs.buildRunPrCandidates = buildRunPrCandidates;
module.exports = autoUpdatePRs;
