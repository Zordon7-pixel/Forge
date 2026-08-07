// Canonical deterministic run-workout vocabulary. Stable IDs are persisted in
// plans so validation and UI labels never depend on title parsing.

const WORKOUTS = Object.freeze({
  easy_aerobic: Object.freeze({ id: 'easy_aerobic', family: 'easy', type: 'easy', quality: false }),
  recovery_run: Object.freeze({ id: 'recovery_run', family: 'recovery', type: 'recovery', quality: false }),
  long_aerobic: Object.freeze({ id: 'long_aerobic', family: 'long', type: 'long', quality: false }),
  strides: Object.freeze({ id: 'strides', family: 'speed', type: 'quality', quality: true }),
  short_hill_sprints: Object.freeze({ id: 'short_hill_sprints', family: 'hills', type: 'hills', quality: true }),
  aerobic_hill_repeats: Object.freeze({ id: 'aerobic_hill_repeats', family: 'hills', type: 'hills', quality: true }),
  uphill_threshold_repeats: Object.freeze({ id: 'uphill_threshold_repeats', family: 'hills', type: 'hills', quality: true }),
  fartlek: Object.freeze({ id: 'fartlek', family: 'speed', type: 'quality', quality: true }),
  short_intervals: Object.freeze({ id: 'short_intervals', family: 'intervals', type: 'quality', quality: true }),
  long_intervals: Object.freeze({ id: 'long_intervals', family: 'intervals', type: 'quality', quality: true }),
  tempo_threshold: Object.freeze({ id: 'tempo_threshold', family: 'threshold', type: 'quality', quality: true }),
  progression_run: Object.freeze({ id: 'progression_run', family: 'progression', type: 'steady', quality: true }),
  race_pace_intervals: Object.freeze({ id: 'race_pace_intervals', family: 'race_pace', type: 'race_pace', quality: true }),
  sharpening_strides: Object.freeze({ id: 'sharpening_strides', family: 'sharpening', type: 'sharpen', quality: true }),
  benchmark_mile: Object.freeze({ id: 'benchmark_mile', family: 'benchmark', type: 'benchmark', quality: true }),
  race: Object.freeze({ id: 'race', family: 'race', type: 'race', quality: true }),
});

const QUALITY_TYPES = new Set(['quality', 'hills', 'race_pace', 'sharpen']);

function workoutForId(id) {
  return WORKOUTS[id] || null;
}

function isQualityWorkout(id) {
  return Boolean(workoutForId(id)?.quality);
}

function workoutIdForSession(type, options = {}) {
  const normalizedType = String(type || 'easy').toLowerCase();
  const phase = String(options.phase || 'base').toLowerCase();
  const weekNumber = Math.max(1, Number(options.weekNumber || 1));
  const weeklyMiles = Math.max(0, Number(options.weeklyMiles || 0));
  const meaningfulRunCount = Math.max(0, Number(options.meaningfulRunCount || 0));
  const conservative = Boolean(options.conservative) || weeklyMiles < 5 || meaningfulRunCount < 3;
  const experienced = weeklyMiles >= 10 && meaningfulRunCount >= 6;

  if (normalizedType === 'race') return 'race';
  if (normalizedType === 'benchmark') return 'benchmark_mile';
  if (normalizedType === 'long') return 'long_aerobic';
  if (normalizedType === 'recovery') return 'recovery_run';
  if (normalizedType === 'easy') return 'easy_aerobic';
  if (conservative) return 'strides';
  if (normalizedType === 'steady') return 'progression_run';
  if (normalizedType === 'race_pace') return 'race_pace_intervals';
  if (normalizedType === 'sharpen') return 'sharpening_strides';

  if (normalizedType === 'hills') {
    if (phase === 'peak' && experienced) return 'uphill_threshold_repeats';
    return weekNumber % 2 === 0 ? 'short_hill_sprints' : 'aerobic_hill_repeats';
  }

  if (QUALITY_TYPES.has(normalizedType)) {
    if (phase === 'base') return weekNumber % 2 === 0 ? 'fartlek' : 'strides';
    if (phase === 'deload') return 'strides';
    if (phase === 'taper') return 'sharpening_strides';
    if (phase === 'peak') {
      if (options.hilly && weekNumber % 3 === 0) return 'uphill_threshold_repeats';
      if (options.hasTimedGoal && weekNumber % 2 === 0) return 'race_pace_intervals';
      return experienced ? 'long_intervals' : 'tempo_threshold';
    }
    const buildSequence = experienced
      ? ['tempo_threshold', 'fartlek', 'long_intervals', 'progression_run']
      : ['fartlek', 'tempo_threshold', 'short_intervals', 'progression_run'];
    return buildSequence[(weekNumber - 1) % buildSequence.length];
  }

  return 'easy_aerobic';
}

function qualityBlock({ repetitions, work, recovery, target, recoveryType = 'easy jog' }) {
  return {
    repetitions,
    work,
    recovery: { type: recoveryType, duration: recovery },
    target,
  };
}

function prescriptionFor(workoutId, options = {}) {
  const goalPaceLabel = options.goalPaceLabel || null;
  const phase = String(options.phase || 'base').toLowerCase();
  const progress = Number(options.weekNumber || 1) / Math.max(1, Number(options.weekCount || 1));

  const prescriptions = {
    strides: {
      title: 'Easy run with strides', target_zone: 'Zone 2 with short relaxed strides', pace_target: 'Easy running; fast but relaxed strides', intensity: 'Controlled speed introduction',
      warmup: ['12 min easy running', 'Dynamic ankle and hip mobility'],
      quality_prescription: qualityBlock({ repetitions: 6, work: '20 sec relaxed fast', recovery: '60 sec', target: 'Smooth form; never sprint' }),
      steps: ['6 x 20 sec relaxed strides', '60 sec easy jog between repetitions'], cooldown: ['8 min easy running'],
      progression: 'Add no repetitions until every stride stays relaxed and pain-free.',
      description: 'Maintain leg speed with low fatigue when a larger quality session is not yet appropriate.',
    },
    short_hill_sprints: {
      title: 'Short hill sprints', target_zone: 'Form-led; full recovery', pace_target: 'Fast and relaxed uphill, never all-out', intensity: 'Short neuromuscular speed',
      warmup: ['15 min easy running', '4 x 20 sec relaxed strides'],
      quality_prescription: qualityBlock({ repetitions: 6, work: '10 sec uphill', recovery: '90 sec', target: 'Tall posture and quick cadence', recoveryType: 'full walk-back' }),
      steps: ['6 x 10 sec uphill', 'Walk back fully; begin only when breathing is settled'], cooldown: ['10 min easy running'],
      progression: 'Add one repetition only after all six remain crisp and pain-free.',
      description: 'Build running-specific force with very short work and complete recovery.',
    },
    aerobic_hill_repeats: {
      title: 'Controlled hill repeats', target_zone: 'Zone 3', pace_target: 'Controlled uphill effort', intensity: 'Hard but repeatable',
      warmup: ['12 min easy running', '4 x 20 sec relaxed strides'],
      quality_prescription: qualityBlock({ repetitions: 6, work: '60 sec uphill', recovery: '90 sec', target: 'Zone 3; even effort', recoveryType: 'easy jog down' }),
      steps: ['6 x 60 sec uphill', '90 sec easy jog down between repetitions'], cooldown: ['10 min easy running'],
      progression: 'Progress to eight repetitions only after six are even and controlled.',
      description: 'Build general climbing strength and aerobic durability without sprinting.',
    },
    uphill_threshold_repeats: {
      title: 'Uphill threshold repeats', target_zone: 'Zone 3-4', pace_target: 'Threshold effort by breathing, not flat-ground pace', intensity: 'Sustained and controlled',
      warmup: ['15 min easy running', '4 x 20 sec relaxed strides'],
      quality_prescription: qualityBlock({ repetitions: 4, work: '3 min uphill', recovery: '2 min', target: 'Threshold effort with stable form', recoveryType: 'easy jog' }),
      steps: ['4 x 3 min uphill at threshold effort', '2 min easy jog between repetitions'], cooldown: ['12 min easy running'],
      progression: 'Extend the final repetition only after all four stay even.',
      description: 'Develop course-specific climbing strength and sustainable uphill speed.',
    },
    fartlek: {
      title: 'Controlled fartlek', target_zone: 'Zone 2-4', pace_target: 'One minute controlled hard, one minute easy', intensity: 'Variable but repeatable',
      warmup: ['12 min easy running', '4 x 20 sec relaxed strides'],
      quality_prescription: qualityBlock({ repetitions: 8, work: '1 min controlled hard', recovery: '1 min', target: 'Fast with relaxed form', recoveryType: 'easy float' }),
      steps: ['8 x 1 min controlled hard', '1 min easy float between repetitions'], cooldown: ['10 min easy running'],
      progression: 'Add two repetitions before making the hard minutes faster.',
      description: 'Introduce speed changes without rigid track pacing.',
    },
    short_intervals: {
      title: 'Short speed intervals', target_zone: 'Zone 4 during work', pace_target: 'Fast, controlled, and repeatable', intensity: 'High aerobic',
      warmup: ['15 min easy running', '4 x 20 sec relaxed strides'],
      quality_prescription: qualityBlock({ repetitions: 8, work: '1 min fast', recovery: '90 sec', target: 'Zone 4 by the final repetitions', recoveryType: 'easy jog' }),
      steps: ['8 x 1 min fast and controlled', '90 sec easy jog between repetitions'], cooldown: ['12 min easy running'],
      progression: 'Reduce recovery only after pace and form remain even.',
      description: 'Improve speed reserve without requiring a large volume of hard running.',
    },
    long_intervals: {
      title: 'Long aerobic intervals', target_zone: 'Zone 4', pace_target: 'Current 5K-10K effort, controlled', intensity: 'Hard but repeatable',
      warmup: ['15 min easy running', '4 x 20 sec relaxed strides'],
      quality_prescription: qualityBlock({ repetitions: 5, work: '3 min controlled hard', recovery: '2 min', target: 'Even high-aerobic effort', recoveryType: 'easy jog' }),
      steps: ['5 x 3 min controlled hard', '2 min easy jog between repetitions'], cooldown: ['12 min easy running'],
      progression: 'Add work time only after every repetition is completed evenly.',
      description: 'Raise aerobic power while preserving repeatable mechanics.',
    },
    tempo_threshold: {
      title: 'Threshold intervals', target_zone: 'Zone 3-4', pace_target: 'Current threshold effort', intensity: 'Comfortably hard and controlled',
      warmup: ['15 min easy running', '4 x 20 sec relaxed strides'],
      quality_prescription: qualityBlock({ repetitions: 4, work: '5 min threshold', recovery: '2 min', target: 'Even sustainable effort', recoveryType: 'easy jog' }),
      steps: ['4 x 5 min at controlled threshold effort', '2 min easy jog between repetitions'], cooldown: ['10 min easy running'],
      progression: 'Extend one repetition before increasing pace.',
      description: 'Raise sustainable speed without turning the workout into a race.',
    },
    progression_run: {
      title: 'Progression run', target_zone: 'Zone 2-3', pace_target: 'Start conversational; finish controlled steady', intensity: 'Progressive aerobic',
      warmup: ['10 min very easy running'],
      quality_prescription: qualityBlock({ repetitions: 1, work: '20 min progressive', recovery: 'None', target: 'Finish in Zone 3 without sprinting', recoveryType: 'continuous' }),
      steps: ['10 min easy', '10 min steady', 'Final 5-10 min controlled in Zone 3'], cooldown: ['8 min easy running'],
      progression: 'Extend the steady middle before making the finish faster.',
      description: 'Practice controlled pace changes while staying below race effort.',
    },
    race_pace_intervals: {
      title: 'Goal-pace intervals', target_zone: 'Race-specific effort', pace_target: `${goalPaceLabel || 'Goal race pace'} during work intervals`, intensity: 'Controlled goal pace',
      warmup: ['15 min easy running', '4 x 20 sec relaxed strides'],
      quality_prescription: qualityBlock({ repetitions: 3, work: progress >= 0.75 ? '10 min at goal pace' : progress >= 0.55 ? '8 min at goal pace' : '6 min at goal pace', recovery: '3 min', target: goalPaceLabel || 'Goal race effort', recoveryType: 'easy jog' }),
      steps: [`3 x ${progress >= 0.75 ? 10 : progress >= 0.55 ? 8 : 6} min at ${goalPaceLabel || 'goal race effort'}`, '3 min easy jog between repetitions'], cooldown: ['10 min easy running'],
      progression: 'Complete every repetition evenly before extending total time at goal pace.',
      description: 'Practice the exact race target in controlled segments without running a time trial.',
    },
    sharpening_strides: {
      title: goalPaceLabel ? 'Race-pace sharpening' : 'Taper strides', target_zone: goalPaceLabel ? 'Race-specific effort' : 'Zone 3-4', pace_target: goalPaceLabel || 'Fast and relaxed', intensity: 'Short and controlled',
      warmup: ['10 min easy running', '4 x 20 sec relaxed strides'],
      quality_prescription: qualityBlock({ repetitions: 6, work: '60 sec', recovery: '90 sec', target: goalPaceLabel || 'Goal race effort', recoveryType: 'easy jog' }),
      steps: [`6 x 60 sec at ${goalPaceLabel || 'goal race effort'}`, '90 sec easy jog between repetitions'], cooldown: ['8 min easy running'],
      progression: 'Keep the session short; the goal is freshness, not added fitness.',
      description: 'Preserve race rhythm while taper volume falls.',
    },
  };

  const prescription = prescriptions[workoutId];
  if (!prescription) return null;
  return {
    ...prescription,
    workout_id: workoutId,
    workout_family: WORKOUTS[workoutId].family,
    purpose: prescription.description,
    prescription_basis: 'time',
    phase,
  };
}

module.exports = {
  WORKOUTS,
  workoutForId,
  isQualityWorkout,
  workoutIdForSession,
  prescriptionFor,
};
