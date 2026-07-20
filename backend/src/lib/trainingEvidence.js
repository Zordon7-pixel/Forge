// Public research and coaching references used by the deterministic plan engine.
// Elite examples inform principles only; athlete history controls the dosage.

const SOURCES = Object.freeze({
  intensity_distribution: Object.freeze({
    id: 'intensity_distribution',
    kind: 'research',
    title: 'Training-intensity distribution in distance runners',
    publisher: 'Sports Medicine systematic review (PubMed)',
    url: 'https://pubmed.ncbi.nlm.nih.gov/34749417/',
    principle: 'Keep most running low intensity and use a smaller dose of threshold or high-intensity work.',
  }),
  elite_periodization: Object.freeze({
    id: 'elite_periodization',
    kind: 'research',
    title: 'Periodization and methods in elite distance runners',
    publisher: 'International Journal of Sports Physiology and Performance (PubMed)',
    url: 'https://pubmed.ncbi.nlm.nih.gov/35418513/',
    principle: 'Use hard-day/easy-day structure and progress from general aerobic work toward race-specific training.',
  }),
  ten_mile_time_plan: Object.freeze({
    id: 'ten_mile_time_plan',
    kind: 'coach_plan',
    title: '10 Mile Improver Training Plan',
    publisher: 'Great Run',
    url: 'https://www.greatrun.org/train-and-prepare/training-plans/10-mile/',
    principle: 'Time-based easy runs and a progressive long-duration run are valid anchors for a 10-mile PR block.',
  }),
  strength_running_economy: Object.freeze({
    id: 'strength_running_economy',
    kind: 'research',
    title: 'Strength training and running performance',
    publisher: 'Sports Medicine systematic review (PubMed)',
    url: 'https://pubmed.ncbi.nlm.nih.gov/29249083/',
    principle: 'Two to three well-planned strength sessions can support running economy and performance without inherently harming body composition.',
  }),
  ingebrigtsen_progression: Object.freeze({
    id: 'ingebrigtsen_progression',
    kind: 'athlete_practice',
    title: 'Inside the Training of Jakob Ingebrigtsen',
    publisher: 'COROS athlete training data',
    url: 'https://coros.com/stories/athlete-stories/c/inside-the-training-of-jakob-ingebrigtsen',
    principle: 'Build volume before intensity, keep load changes even, and scale race-pace repetitions to the athlete rather than copying elite volume.',
  }),
  kipchoge_recovery: Object.freeze({
    id: 'kipchoge_recovery',
    kind: 'athlete_practice',
    title: 'Recovery-day training and Eliud Kipchoge',
    publisher: 'Nike coaching',
    url: 'https://www.nike.com/a/plan-your-ideal-recovery-day-workout',
    principle: 'Recovery running is deliberately much easier than race effort; its purpose is absorption, not proving fitness.',
  }),
});

const RUN_REFS = Object.freeze({
  recovery: ['intensity_distribution', 'kipchoge_recovery'],
  easy: ['intensity_distribution', 'ten_mile_time_plan'],
  steady: ['intensity_distribution', 'elite_periodization'],
  long: ['ten_mile_time_plan', 'elite_periodization'],
  hills: ['elite_periodization', 'ingebrigtsen_progression'],
  quality: ['elite_periodization', 'ingebrigtsen_progression'],
  race_pace: ['elite_periodization', 'ten_mile_time_plan'],
  sharpen: ['elite_periodization', 'ingebrigtsen_progression'],
  race: ['elite_periodization', 'ten_mile_time_plan'],
});

function sourceForId(id) {
  const source = SOURCES[id];
  return source ? { ...source } : null;
}

function runEvidenceRefs(type) {
  return [...(RUN_REFS[String(type || '').toLowerCase()] || RUN_REFS.easy)];
}

function strengthEvidenceRefs() {
  return ['strength_running_economy'];
}

function planEvidence(mode) {
  const ids = [
    'intensity_distribution',
    'elite_periodization',
    'ten_mile_time_plan',
    'ingebrigtsen_progression',
    'kipchoge_recovery',
  ];
  if (String(mode || '') !== 'run_only') ids.push('strength_running_economy');
  return ids.map(sourceForId).filter(Boolean);
}

module.exports = {
  SOURCES,
  sourceForId,
  runEvidenceRefs,
  strengthEvidenceRefs,
  planEvidence,
};
