const { dbGet, dbRun } = require('../db');
const { v4: uuidv4 } = require('uuid');

const RACE_WINDOWS = [
  { label: '1 Mile PR', miles: 1.0 },
  { label: '5K PR', miles: 3.107 },
  { label: '10K PR', miles: 6.214 },
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

module.exports = async function autoUpdatePRs(userId, run) {
  const result = { newPRs: [], discrepancies: [] };
  if (!run || !userId) return result;

  const distance = Number(run.distance_miles || 0);
  const durationSeconds = Number(run.duration_seconds || 0);
  const runDate = formatDate(run.date);

  if (!distance || !durationSeconds) return result;

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
    RACE_WINDOWS.forEach(race => {
      const diffRatio = Math.abs(distance - race.miles) / race.miles;
      if (diffRatio <= DISTANCE_TOLERANCE) {
        candidates.push({ label: race.label, value: round(pacePerMile), unit: 'min/mi', direction: 'lower' });
      }
    });
  }

  for (const candidate of candidates) {
    if (candidate.value == null) continue;
    try {
      const existing = await dbGet(
        `SELECT * FROM personal_records WHERE user_id = ? AND category = 'run' AND label = ?`,
        [userId, candidate.label]
      );

      if (!existing) {
        const id = uuidv4();
        await dbRun(
          `INSERT INTO personal_records (id, user_id, category, label, value, unit, run_id, achieved_at, source, discrepancy, auto_value) VALUES (?, ?, 'run', ?, ?, ?, ?, ?, 'auto', 0, NULL)`,
          [id, userId, candidate.label, candidate.value, candidate.unit, run.id, runDate]
        );
        result.newPRs.push(candidate.label);
        continue;
      }

      if (existing.source === 'auto') {
        if (isBetter(candidate.value, Number(existing.value), candidate.direction)) {
          await dbRun(
            `UPDATE personal_records SET value = ?, unit = ?, run_id = ?, achieved_at = ?, discrepancy = 0, auto_value = NULL, source = 'auto' WHERE id = ?`,
            [candidate.value, candidate.unit, run.id, runDate, existing.id]
          );
          result.newPRs.push(candidate.label);
        }
        continue;
      }

      if (existing.source === 'manual' && isBetter(candidate.value, Number(existing.value), candidate.direction)) {
        await dbRun(
          `UPDATE personal_records SET discrepancy = 1, auto_value = ? WHERE id = ?`,
          [candidate.value, existing.id]
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
};
