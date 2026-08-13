// Forged Hybrid seven-day run-gap re-entry smoke.
// Run: node backend/test/runGapReentry.smoke.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const adaptation = require('../src/lib/adaptationEngine');
const schema = require('../src/lib/planSchema');

const planningDateISO = '2026-08-03';

function run(id, title, miles, duration, type = 'quality') {
  return {
    id,
    kind: 'run',
    type,
    workout_type: 'run',
    title,
    distance_miles: miles,
    duration_min: duration,
    intensity: type === 'easy' ? 'Easy' : 'Hard',
    target_zone: type === 'easy' ? 'Zone 2' : 'Zone 4',
    pace_target: type === 'easy' ? 'Conversational effort' : 'Threshold effort',
  };
}

function plan({ includeRace = true, runCount = 4 } = {}) {
  const sessions = [
    run('monday-quality', 'Threshold intervals', 5, 50),
    run('wednesday-easy', 'Easy aerobic run', 4, 42, 'easy'),
    run('friday-hills', 'Hill repeats', 5, 48),
    run('sunday-long', 'Long aerobic run', 8, 82),
  ].slice(0, runCount);
  const dates = ['2026-08-03', '2026-08-05', '2026-08-07', '2026-08-09'];
  const days = sessions.map((session, index) => ({
    day: ['Mon', 'Wed', 'Fri', 'Sun'][index],
    date: dates[index],
    sessions: [session],
  }));
  if (includeRace) {
    days.push({
      day: 'Sat',
      date: '2026-08-08',
      sessions: [{
        id: 'protected-race',
        kind: 'run',
        type: 'race',
        workout_type: 'race',
        title: 'Tune-up 5K race',
        distance_miles: 3.1,
        duration_min: 28,
        target_zone: 'Race effort',
      }],
    });
  }
  return {
    schemaVersion: 2,
    planMode: 'run_only',
    strengthPolicy: { minimumSessionsPerWeek: 0 },
    goal: {
      kind: 'race',
      raceId: 'army-10-miler-2026',
      name: 'Army Ten-Miler',
      date: '2026-10-11',
      distanceMiles: 10,
      goalType: 'time',
      goalTimeSeconds: 5220,
      goalPaceSecondsPerMile: 522,
      priority: 'A',
      sequence: 2,
      role: 'primary',
    },
    goals: [
      {
        kind: 'race', raceId: 'yonkers-half-2026', name: 'Yonkers Half Marathon', date: '2026-09-20',
        distanceMiles: 13.1, goalType: 'time', goalTimeSeconds: 7200, goalPaceSecondsPerMile: 550,
        priority: 'A', sequence: 1, role: 'primary',
      },
      {
        kind: 'race', raceId: 'army-10-miler-2026', name: 'Army Ten-Miler', date: '2026-10-11',
        distanceMiles: 10, goalType: 'time', goalTimeSeconds: 5220, goalPaceSecondsPerMile: 522,
        priority: 'A', sequence: 2, role: 'primary',
      },
    ],
    weeks: [{ week: 1, phase: 'build', days }],
  };
}

function proposalFor(overrides = {}, sourcePlan = plan()) {
  return adaptation.buildAdaptationProposal({
    plan: sourcePlan,
    planningDateISO,
    planVersion: 'gap-v1',
    completion: {
      lastRunDate: '2026-07-27',
      daysSinceRun: 7,
      weeklyMileageBaseline: 20,
      gapPromptEnabled: true,
      runGapEpisodeKey: 'run-gap:2026-07-27',
      ...overrides,
    },
  });
}

const sixDays = proposalFor({ lastRunDate: '2026-07-28', daysSinceRun: 6 });
assert.equal(sixDays.status, 'keep', 'six days without a run does not trigger');

const sevenDays = proposalFor();
assert.equal(sevenDays.status, 'proposal', 'seven days without a run triggers');
assert.equal(sevenDays.windowEnd, '2026-08-09', 're-entry window is exactly seven calendar days');
assert.equal(sevenDays.evidence.some((item) => item.signal === 'run_gap' && item.episodeKey === 'run-gap:2026-07-27'), true);

const liftYesterday = proposalFor({ lastTrainingDate: '2026-08-02', daysSinceAnyTraining: 1 });
assert.equal(liftYesterday.status, 'proposal', 'a recent lift does not mask a seven-day running gap');

const plannedRest = proposalFor({ missedWorkouts: 0, missedRuns: 0 });
assert.equal(plannedRest.status, 'proposal', 'planned rest days do not suppress a seven-day running gap');

const noRunHistory = proposalFor({ lastRunDate: null, daysSinceRun: null, runGapEpisodeKey: null });
assert.equal(noRunHistory.status, 'keep', 'a new athlete without a prior run is not labelled inactive');

const applied = adaptation.applyProposalToPlan(plan(), sevenDays);
const changedRunSessions = sevenDays.changes
  .filter((change) => change.kind === 'run' && change.after?.type !== 'rest' && change.after?.type !== 'race')
  .map((change) => change.after);
assert.equal(changedRunSessions.length > 0, true);
assert.equal(changedRunSessions[0].duration_min <= 30, true, 'first re-entry run is at most 30 minutes');
assert.equal(changedRunSessions.every((session) => session.target_zone === 'Zone 1-2' && /easy|recovery/i.test(session.intensity)), true, 'all changed runs are easy');
const reentryMiles = changedRunSessions.reduce((sum, session) => sum + Number(session.distance_miles || 0), 0);
assert.equal(reentryMiles <= 14, true, 'known mileage is no more than 70% of the 20-mile baseline');
assert.equal(JSON.stringify(applied.goals), JSON.stringify(plan().goals), 'dual-race goals remain byte-identical');
const protectedRace = schema.getDayEntries(applied.weeks[0]).flatMap((day) => schema.daySessions(day)).find((session) => session.id === 'protected-race');
assert.equal(protectedRace?.title, 'Tune-up 5K race', 'race sessions remain protected');

const noBaselinePlan = plan({ includeRace: false, runCount: 4 });
const noBaseline = proposalFor({ weeklyMileageBaseline: 0 }, noBaselinePlan);
const noBaselineApplied = adaptation.applyProposalToPlan(noBaselinePlan, noBaseline);
const noBaselineRuns = schema.getDayEntries(noBaselineApplied.weeks[0])
  .flatMap((day) => schema.daySessions(day))
  .filter((session) => schema.kindFromSession(session) === 'run');
assert.equal(noBaselineRuns.length <= 3, true, 'unknown baseline retains at most three easy runs');
assert.equal(noBaselineRuns.reduce((sum, session) => sum + Number(session.distance_miles || 0), 0) <= 9, true, 'unknown baseline stays under the nine-mile guardrail');

const fractionalPlan = {
  ...plan({ includeRace: false, runCount: 3 }),
  weeks: [{
    week: 1,
    phase: 'build',
    days: ['2026-08-03', '2026-08-05', '2026-08-07'].map((date, index) => ({
      day: ['Mon', 'Wed', 'Fri'][index],
      date,
      sessions: [run(`fractional-${index}`, 'Easy run', 0.6, 20, 'easy')],
    })),
  }],
};
const fractionalProposal = proposalFor({ weeklyMileageBaseline: 10 }, fractionalPlan);
const fractionalMiles = fractionalProposal.changes
  .filter((change) => change.kind === 'run')
  .reduce((sum, change) => sum + Number(change.after?.distance_miles || 0), 0);
assert.equal(fractionalMiles <= 1.44, true, 'per-session rounding never exceeds the exact 80% aggregate cap');
assert.equal(fractionalProposal.changes.filter((change) => change.kind === 'run').every((change) => (
  change.after?.reentry_adjustment?.mileageScale === Math.round((Number(change.after?.distance_miles || 0) / 0.6) * 1000) / 1000
)), true, 'fractional-session metadata matches each final prescribed distance');

const injuryProposal = adaptation.buildAdaptationProposal({
  plan: {
    ...plan({ includeRace: false, runCount: 1 }),
    weeks: [{ week: 1, phase: 'build', days: [{
      day: 'Mon',
      date: planningDateISO,
      sessions: [run('injury-composition', 'Long run', 10, 60)],
    }] }],
  },
  planningDateISO,
  planVersion: 'gap-injury-v1',
  completion: {
    lastRunDate: '2026-07-27', daysSinceRun: 7, weeklyMileageBaseline: 10,
    gapPromptEnabled: true, runGapEpisodeKey: 'run-gap:2026-07-27',
  },
  injuryState: {
    activeInjuries: [{
      id: 'calf-injury', severity: 'moderate', bodyPart: 'calf', date: planningDateISO,
    }],
  },
  healthSignals: {
    metrics: {
      sleepHoursLastNight: { value: 4.8, source: 'apple_health', asOf: planningDateISO, freshness: 'fresh', suspect: false },
    },
  },
  recentRunLoad: {
    latestRun: { distanceMiles: 7.3, durationMinutes: 75, daysSince: 1 },
    protection: {
      active: true,
      noAdditionalRunOnDate: null,
      hardRunsThrough: '2026-08-05',
      lowerBodyThrough: '2026-08-05',
      upperBodyOptionalThrough: '2026-08-04',
      postRunSevere: false,
    },
  },
});
const composedRun = injuryProposal.changes.find((change) => change.sessionId === 'injury-composition')?.after;
assert.equal(composedRun.distance_miles <= 7, true, 'injury composition cannot loosen the baseline re-entry mileage cap');
assert.equal(composedRun.duration_min <= 30, true, 'injury composition cannot loosen the first-run duration cap');
assert.equal(composedRun.injury_adjustment?.body_part, 'calf', 'full signal composition preserves injury metadata');
assert.match(composedRun.pace_target, /calf symptoms change your stride/i, 'full signal composition preserves the body-part stop warning');
assert.equal(composedRun.steps.some((step) => /calf pain increases/i.test(step)), true, 'full signal composition preserves injury reassessment cues');
assert.match(composedRun.progression, /injury log is cleared/i, 'full signal composition preserves injury progression guidance');
assert.equal(
  composedRun.reentry_adjustment?.mileageScale,
  Math.round((Number(composedRun.distance_miles) / 10) * 1000) / 1000,
  're-entry metadata records the actual final mileage scale after all safety composition'
);

const original = plan();
const originalBytes = JSON.stringify(original);
const keepDecision = proposalFor({}, original);
assert.equal(JSON.stringify(original), originalBytes, 'building or keeping a proposal never mutates the source calendar');
assert.deepEqual(keepDecision.choices, ['accept', 'keep_original']);

const repoRoot = path.resolve(__dirname, '../..');
const routesSource = fs.readFileSync(path.join(repoRoot, 'backend/src/routes/plans.js'), 'utf8');
const dashboardSource = fs.readFileSync(path.join(repoRoot, 'frontend/src/pages/Dashboard.jsx'), 'utf8');
assert.match(routesSource, /WHERE user_id=\? AND episode_key=\? AND trigger_run_id IS NULL/, 'episode lookup is direct and user scoped');
assert.match(routesSource, /adaptationEpisodeDisposition\(runGapEpisode, planVersion\)/, 'episode reuse is tied to the current plan version');
assert.match(routesSource, /runGapDisposition === 'reuse'/, 'only a current pending episode is reused across planning dates');
assert.match(routesSource, /SET id=\?, user_plan_id=\?[\s\S]*status='pending'[\s\S]*decided_at=NULL/, 'a superseded episode gets a new review identity without duplicating its stable key');
assert.match(routesSource, /episodeKey\s*\?\s*await findRunGapEpisode/, 'proposal persistence de-duplicates by the stable episode key');
assert.match(dashboardSource, /Lifting still counts; this check is only about returning to running safely/, 'prompt is nonpunitive and run-specific');
assert.match(dashboardSource, /Ease my return/);
assert.match(dashboardSource, /Keep original/);

console.log('RUN GAP RE-ENTRY SMOKE OK (32)');
