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

// Canonical stored miles (the run API/import normalizers own unit conversion).
// Keep the historical targets/labels used by manual time PRs and their readers.
const TIME_PR_DISTANCE_TOLERANCE = 0.01;
const STANDARD_TIME_PRS = Object.freeze(RACE_WINDOWS.map(({ label, miles }) => Object.freeze({
  label: label.replace(/ PR$/, ''),
  target: miles,
  min: miles * (1 - TIME_PR_DISTANCE_TOLERANCE),
  max: miles * (1 + TIME_PR_DISTANCE_TOLERANCE),
})));

function nearestStandardTimePr(value) {
  const miles = Number(value);
  if (!Number.isFinite(miles) || miles <= 0) return null;
  return STANDARD_TIME_PRS
    // Compare endpoints directly: subtraction/ratio rounding can reject an
    // inclusive boundary. Do not add epsilon (that admits the next float).
    .map((item, order) => ({ item, order, ratio: Math.abs(miles - item.target) / item.target }))
    .filter(({ item }) => miles >= item.min && miles <= item.max)
    .sort((a, b) => a.ratio - b.ratio || a.order - b.order)[0]?.item || null;
}

function timePrLabel(distance) {
  return `Time PR: ${distance.label}`;
}

function buildTimePrCandidate(run) {
  if (!run || !isRunActivity(run)) return null;
  const distance = nearestStandardTimePr(run.distance_miles);
  const seconds = Number(run.duration_seconds);
  if (!distance || !Number.isFinite(seconds) || seconds <= 0) return null;
  return { label: timePrLabel(distance), value: seconds, unit: 'seconds', direction: 'lower' };
}

async function updateTimePr(userId, run, db, result) {
  if (!run.id || !buildTimePrCandidate(run)) return;
  // Never link caller-supplied metrics or another account's run. Read the exact
  // canonical row inside the caller's existing owner mutation transaction.
  const ownedRun = await db.get('SELECT * FROM runs WHERE id=? AND user_id=?', [run.id, userId]);
  const candidate = buildTimePrCandidate(ownedRun);
  if (!candidate) return;
  const existing = await db.get(
    `SELECT * FROM personal_records WHERE user_id=? AND category='time_pr'
     AND label=? AND source='auto' AND run_id IS NOT NULL`,
    [userId, candidate.label]
  );
  if (existing) {
    if (!isBetter(candidate.value, Number(existing.value))) return;
    await db.run(
      `UPDATE personal_records SET value=?, unit='seconds', run_id=?, achieved_at=?
       WHERE id=? AND user_id=? AND category='time_pr' AND source='auto' AND value>?`,
      [candidate.value, ownedRun.id, ownedRun.date, existing.id, userId, candidate.value]
    );
  } else {
    await db.run(
      `INSERT INTO personal_records (id, user_id, category, label, value, unit, run_id, achieved_at, source)
       VALUES (?, ?, 'time_pr', ?, ?, 'seconds', ?, ?, 'auto')`,
      [uuidv4(), userId, candidate.label, candidate.value, ownedRun.id, ownedRun.date]
    );
  }
  result.newPRs.push(candidate.label);
}

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

  await updateTimePr(userId, run, db, result);

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
      if (options.strictErrors) throw err;
      console.error('PR auto-detect error for', candidate.label, err.message);
    }
  }

  return result;
}

async function recomputeRunPrCategories(userId, categoryLabels = [], options = {}) {
  if (!userId) return { recomputed: [], removed: [] };
  const result = { recomputed: [], removed: [] };
  const db = getDb(options);
  // Import/canonical-run correction callers historically pass only run labels.
  // Include this owner's linked time records so those same transactions also
  // revoke provisional times. Unlinked legacy manual entries are excluded.
  const timeRows = await db.all(
    "SELECT label FROM personal_records WHERE user_id=? AND category='time_pr' AND source='auto' AND run_id IS NOT NULL",
    [userId]
  );
  const labels = [...new Set([...(categoryLabels || []), ...timeRows.map(row => row.label)].filter(Boolean))];
  if (!labels.length) return result;
  const runs = await db.all(
    `SELECT * FROM runs WHERE user_id=? AND ${runActivitySql()} ORDER BY date ASC, created_at ASC, id ASC`,
    [userId]
  );

  for (const label of labels) {
    const isTimePr = STANDARD_TIME_PRS.some(distance => timePrLabel(distance) === label);
    const autoPr = await db.get(
      isTimePr
        ? "SELECT * FROM personal_records WHERE user_id=? AND category='time_pr' AND label=? AND source='auto' AND run_id IS NOT NULL"
        : `SELECT * FROM personal_records WHERE user_id=? AND category='run' AND label=? AND ${options.includeManualDiscrepancies ? "source IN ('auto','manual')" : "source='auto'"}`,
      [userId, label]
    );
    if (!autoPr) continue;

    const direction = getCandidateDirection(label);
    let best = null;
    for (const run of runs) {
      const candidate = isTimePr
        ? [buildTimePrCandidate(run)].find(item => item?.label === label)
        : buildRunPrCandidates(run).find((item) => item.label === label);
      if (!candidate || candidate.value == null) continue;
      if (!best || isBetter(candidate.value, best.value, direction)
        || (isTimePr && candidate.value === best.value && run.id === autoPr.run_id)) {
        best = {
          ...candidate,
          run,
          achieved_at: formatDate(run.date),
        };
      }
    }

    if (autoPr.source === 'manual') {
      // The user-entered record is immutable here; only its derived comparison
      // with current canonical activities is refreshed.
      const discrepancy = Boolean(best && isBetter(best.value, Number(autoPr.value), direction));
      await db.run(
        "UPDATE personal_records SET discrepancy=?, auto_value=? WHERE id=? AND user_id=? AND source='manual'",
        [discrepancy ? 1 : 0, discrepancy ? best.value : null, autoPr.id, userId]
      );
      result.recomputed.push(label);
      continue;
    }

    if (!best) {
      await db.run('DELETE FROM personal_records WHERE id=? AND user_id=? AND source=\'auto\'', [autoPr.id, userId]);
      result.removed.push(label);
      continue;
    }

    // Keep a surviving equal winner (including import retries) linked to the
    // same run; date-only corrections still refresh the achievement date.
    if (isTimePr && Number(autoPr.value) === best.value && autoPr.unit === best.unit
      && autoPr.run_id === best.run.id && autoPr.achieved_at === best.achieved_at
      && !autoPr.discrepancy && autoPr.auto_value == null) {
      result.recomputed.push(label);
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
autoUpdatePRs.STANDARD_TIME_PRS = STANDARD_TIME_PRS;
autoUpdatePRs.TIME_PR_DISTANCE_TOLERANCE = TIME_PR_DISTANCE_TOLERANCE;
autoUpdatePRs.nearestStandardTimePr = nearestStandardTimePr;
autoUpdatePRs.timePrLabel = timePrLabel;
autoUpdatePRs.buildTimePrCandidate = buildTimePrCandidate;
module.exports = autoUpdatePRs;
