const LOWER_BODY_PATTERN = /\b(legs?|quads?|quadriceps|hamstrings?|glutes?|lower)\b/i;
const QUALITY_RUN_PATTERN = /(tempo|interval|speed|quality|threshold|hard)/i;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_LOWER_BODY_SECONDS = 10 * 60;
const INTERFERENCE_REASON = 'recent lower-body strength session in the last 24h, keeping today aerobic Z2 to protect recovery.';

function parseMuscleGroups(value) {
  if (Array.isArray(value)) return value.join(' ');
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return String(value);
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.join(' ');
  } catch (err) {
    if (err instanceof SyntaxError) return value;
    throw err;
  }
  return value;
}

function isRecentHeavyLowerBodySession(session, nowMs) {
  const startedMs = new Date(session?.started_at || '').getTime();
  if (!Number.isFinite(startedMs)) return false;
  if (nowMs - startedMs < 0 || nowMs - startedMs > RECENT_WINDOW_MS) return false;
  if (Number(session?.total_seconds || 0) < MIN_LOWER_BODY_SECONDS) return false;
  return LOWER_BODY_PATTERN.test(parseMuscleGroups(session?.muscle_groups));
}

function isQualityRun(recommendation) {
  const typeText = [
    recommendation?.type,
    recommendation?.recommendationType,
    recommendation?.intensity,
    recommendation?.targetZone,
  ].filter(Boolean).join(' ');
  return QUALITY_RUN_PATTERN.test(typeText);
}

function buildZ2Structure(recommendation) {
  const distance = Number(recommendation?.suggestedDistance || 0);
  const clean = (block) => Object.fromEntries(
    Object.entries(block).filter(([, value]) => value !== null && value !== undefined && value !== '')
  );

  return [
    clean({ phase: 'warmup', label: 'Warmup', durationMinutes: 10, hrZone: 2, description: 'Easy jog or brisk walk, RPE 3/10' }),
    clean({
      phase: 'main',
      label: 'Main',
      hrZone: 2,
      description: 'Conversational pace, Z2 heart rate',
      distanceMiles: distance || null,
    }),
    clean({ phase: 'cooldown', label: 'Cooldown', durationMinutes: 5, hrZone: 1, description: 'Walk + light mobility' }),
  ];
}

function scrubPaceTargets(recommendation) {
  delete recommendation.pace;
  delete recommendation.paceTarget;
  delete recommendation.targetPace;
  recommendation.suggestedPace = null;

  if (!Array.isArray(recommendation.structure)) return;
  recommendation.structure = recommendation.structure.map((block) => {
    if (!block || typeof block !== 'object') return block;
    const next = { ...block };
    delete next.pace;
    delete next.paceTarget;
    delete next.targetPace;
    return next;
  });
}

function applyInterference(recommendation, recentWorkouts) {
  if (!recommendation || typeof recommendation !== 'object') return recommendation;

  const originalType = recommendation.type || recommendation.recommendationType || null;
  const nowMs = Date.now();
  const hasRecentLowerBody = Array.isArray(recentWorkouts)
    && recentWorkouts.some((session) => isRecentHeavyLowerBodySession(session, nowMs));

  if (hasRecentLowerBody && isQualityRun(recommendation)) {
    const adjustedType = 'easy_run';
    recommendation.type = adjustedType;
    recommendation.recommendationType = adjustedType;
    recommendation.targetZone = 'Zone 2';
    recommendation.intensity = 'Conversational aerobic';
    recommendation.progression = 'Easy aerobic run — keep the whole session in Z2 and save intensity for after recovery.';
    recommendation.steps = ['10 min easy warm-up', 'Z2 conversational main set', '5 min cooldown'];
    recommendation.structure = buildZ2Structure(recommendation);
    scrubPaceTargets(recommendation);
    recommendation.reason = INTERFERENCE_REASON;
    recommendation.interference = {
      adjusted: true,
      originalType,
      adjustedType,
      reason: INTERFERENCE_REASON,
    };
    return recommendation;
  }

  recommendation.interference = { adjusted: false };
  return recommendation;
}

module.exports = {
  applyInterference,
};
