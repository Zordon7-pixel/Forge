// Public evidence and coaching references used to explain deterministic rules.
// A source never changes production dosage without qualified reviewer approval.

const ACCESSED_ON = '2026-08-06';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function source(record) {
  return deepFreeze({
    version: 1,
    activationStatus: 'cataloged',
    productionRuleApproved: false,
    qualifiedReviewer: null,
    executable: false,
    accessedOn: ACCESSED_ON,
    licenseUsage: 'Bibliographic facts, links, and an original Forged Hybrid summary only.',
    ...record,
  });
}

const SOURCES = Object.freeze({
  intensity_distribution: source({
    id: 'intensity_distribution',
    kind: 'research',
    activationStatus: 'source_verified',
    title: 'Training-intensity Distribution on Middle- and Long-distance Runners: A Systematic Review',
    publisher: 'International Journal of Sports Medicine (PubMed)',
    url: 'https://pubmed.ncbi.nlm.nih.gov/34749417/',
    identifiers: { pmid: '34749417', doi: '10.1055/a-1559-3623' },
    publishedYear: 2022,
    studyDesign: 'systematic_review',
    evidenceGrade: 'moderate',
    population: 'Middle- and long-distance runners represented in 20 included articles.',
    experienceLevels: ['recreational', 'trained', 'elite'],
    distanceApplicability: ['5k', '10k', '10_mile', 'half_marathon', 'marathon'],
    goalApplicability: ['completion', 'pr'],
    supportedOutcomes: ['endurance performance', 'training-intensity distribution'],
    dosageBounds: { lowIntensityShare: 'Most weekly running; never inferred from a single workout.' },
    contraindications: ['Do not convert an incomplete heart-rate timeline into intensity distribution.', 'Do not copy elite volume.'],
    principle: 'Keep most running low intensity and use a smaller dose of threshold or high-intensity work.',
  }),
  elite_periodization: source({
    id: 'elite_periodization',
    kind: 'research',
    activationStatus: 'source_verified',
    title: 'Training Periodization, Methods, Intensity Distribution, and Volume in Highly Trained and Elite Distance Runners: A Systematic Review',
    publisher: 'International Journal of Sports Physiology and Performance (PubMed)',
    url: 'https://pubmed.ncbi.nlm.nih.gov/35418513/',
    identifiers: { pmid: '35418513', doi: '10.1123/ijspp.2021-0435' },
    publishedYear: 2022,
    studyDesign: 'systematic_review',
    evidenceGrade: 'moderate',
    population: 'Highly trained and elite middle- and long-distance runners.',
    experienceLevels: ['trained', 'elite'],
    distanceApplicability: ['5k', '10k', '10_mile', 'half_marathon', 'marathon'],
    goalApplicability: ['pr'],
    supportedOutcomes: ['periodization', 'hard-day/easy-day structure', 'race-specific preparation'],
    dosageBounds: { transferRule: 'Principles only; scale frequency and volume to the athlete history.' },
    contraindications: ['Elite frequency and volume cannot be copied into a recreational plan.'],
    principle: 'Use hard-day/easy-day structure and progress from general aerobic work toward race-specific training.',
  }),
  interval_programming: source({
    id: 'interval_programming',
    kind: 'research',
    activationStatus: 'source_verified',
    title: 'Programming Interval Training to Optimize Time-Trial Performance: A Systematic Review and Meta-Analysis',
    publisher: 'Sports Medicine (PubMed)',
    url: 'https://pubmed.ncbi.nlm.nih.gov/33826121/',
    identifiers: { pmid: '33826121', doi: '10.1007/s40279-021-01457-2' },
    publishedYear: 2021,
    studyDesign: 'systematic_review_meta_analysis',
    evidenceGrade: 'moderate',
    population: 'Adults aged 18-65 across inactive, active, and trained groups.',
    experienceLevels: ['beginner', 'recreational', 'trained'],
    distanceApplicability: ['5k', '10k', '10_mile', 'half_marathon'],
    goalApplicability: ['pr'],
    supportedOutcomes: ['time-trial performance', 'interval-dose selection'],
    dosageBounds: { transferRule: 'Use the minimum effective interval dose and scale by training status.' },
    contraindications: ['Do not prescribe sprint-interval work to comeback athletes as a default.', 'More interval volume is not automatically better.'],
    principle: 'Use repeatable interval work scaled to training status; increasing dose beyond minimum requirements may not add benefit.',
  }),
  taper_meta_analysis: source({
    id: 'taper_meta_analysis',
    kind: 'research',
    activationStatus: 'source_verified',
    title: 'Effects of tapering on performance in endurance athletes: A systematic review and meta-analysis',
    publisher: 'PLOS ONE (PubMed)',
    url: 'https://pubmed.ncbi.nlm.nih.gov/37163550/',
    identifiers: { pmid: '37163550', doi: '10.1371/journal.pone.0282838' },
    publishedYear: 2023,
    studyDesign: 'systematic_review_meta_analysis',
    evidenceGrade: 'moderate',
    population: 'Endurance athletes represented in 14 included studies.',
    experienceLevels: ['recreational', 'trained', 'elite'],
    distanceApplicability: ['5k', '10k', '10_mile', 'half_marathon', 'marathon'],
    goalApplicability: ['completion', 'pr'],
    supportedOutcomes: ['time-trial performance', 'taper structure'],
    dosageBounds: { duration: 'Up to 21 days', volumeReduction: 'Progressive reduction; exact dose remains a reviewed product rule.' },
    contraindications: ['Do not remove all intensity during taper.', 'Do not use the registry entry as an athlete-specific dosage calculator.'],
    principle: 'Reduce volume before the race while retaining a small dose of familiar intensity and normal frequency when recovery permits.',
  }),
  ten_mile_time_plan: source({
    id: 'ten_mile_time_plan',
    kind: 'coach_plan',
    title: '10 Mile Improver Training Plan',
    publisher: 'Great Run',
    url: 'https://www.greatrun.org/train-and-prepare/training-plans/10-mile/',
    publishedYear: null,
    studyDesign: 'public_coaching_plan',
    evidenceGrade: 'practice_example',
    population: 'Recreational runners preparing for a 10-mile event.',
    experienceLevels: ['recreational'],
    distanceApplicability: ['10_mile'],
    goalApplicability: ['completion', 'pr'],
    supportedOutcomes: ['10-mile plan structure', 'time-based aerobic sessions'],
    dosageBounds: { transferRule: 'Structure only; no table or workout is copied.' },
    contraindications: ['Not individualized clinical guidance.', 'Do not copy proprietary plan tables or wording.'],
    principle: 'Time-based easy runs and a progressive long-duration run are valid anchors for a 10-mile block.',
  }),
  strength_running_economy: source({
    id: 'strength_running_economy',
    kind: 'research',
    activationStatus: 'source_verified',
    title: 'Effects of Strength Training on the Physiological Determinants of Middle- and Long-Distance Running Performance: A Systematic Review',
    publisher: 'Sports Medicine (PubMed)',
    url: 'https://pubmed.ncbi.nlm.nih.gov/29249083/',
    identifiers: { pmid: '29249083', doi: '10.1007/s40279-017-0835-7' },
    publishedYear: 2018,
    studyDesign: 'systematic_review',
    evidenceGrade: 'moderate',
    population: 'Middle- and long-distance runners with at least six months of experience.',
    experienceLevels: ['recreational', 'trained'],
    distanceApplicability: ['5k', '10k', '10_mile', 'half_marathon', 'marathon'],
    goalApplicability: ['completion', 'pr'],
    supportedOutcomes: ['running economy', 'time-trial performance', 'strength integration'],
    dosageBounds: { sessionsPerWeek: 'Two to three in reviewed interventions; athlete scheduling remains individualized.' },
    contraindications: ['Do not place demanding lower-body strength adjacent to a hard or long run.', 'Do not infer benefit for an unrepresented clinical population.'],
    principle: 'Well-planned strength work can support running economy and performance without inherently harming body composition.',
  }),
  ingebrigtsen_progression: source({
    id: 'ingebrigtsen_progression',
    kind: 'athlete_practice',
    title: 'Inside the Training of Jakob Ingebrigtsen',
    publisher: 'COROS athlete training data',
    url: 'https://coros.com/stories/athlete-stories/c/inside-the-training-of-jakob-ingebrigtsen',
    publishedYear: null,
    studyDesign: 'public_athlete_practice',
    evidenceGrade: 'practice_example',
    population: 'One elite middle-distance athlete.',
    experienceLevels: ['elite'],
    distanceApplicability: ['5k', '10k'],
    goalApplicability: ['pr'],
    supportedOutcomes: ['principle illustration only'],
    dosageBounds: { transferRule: 'Never copy elite volume or double-threshold frequency.' },
    contraindications: ['Single-athlete practice is not causal evidence.', 'Not suitable as beginner dosage.'],
    principle: 'Build volume before intensity and scale race-pace repetitions to the athlete rather than copying elite volume.',
  }),
  kipchoge_recovery: source({
    id: 'kipchoge_recovery',
    kind: 'athlete_practice',
    title: 'Recovery-day training and Eliud Kipchoge',
    publisher: 'Nike coaching',
    url: 'https://www.nike.com/a/plan-your-ideal-recovery-day-workout',
    publishedYear: null,
    studyDesign: 'public_coaching_article',
    evidenceGrade: 'practice_example',
    population: 'General audience with an elite-athlete example.',
    experienceLevels: ['recreational', 'elite'],
    distanceApplicability: ['5k', '10k', '10_mile', 'half_marathon', 'marathon'],
    goalApplicability: ['completion', 'pr'],
    supportedOutcomes: ['recovery-day intent'],
    dosageBounds: { transferRule: 'Recovery means easy relative to the individual, not an elite pace.' },
    contraindications: ['Do not copy an elite recovery pace.', 'Pain or illness can require rest instead of recovery running.'],
    principle: 'Recovery running is deliberately much easier than race effort; its purpose is absorption, not proving fitness.',
  }),
});

const RUN_REFS = Object.freeze({
  recovery_run: ['intensity_distribution', 'kipchoge_recovery'],
  easy_aerobic: ['intensity_distribution', 'ten_mile_time_plan'],
  long_aerobic: ['intensity_distribution', 'elite_periodization', 'ten_mile_time_plan'],
  strides: ['elite_periodization', 'interval_programming'],
  short_hill_sprints: ['elite_periodization', 'interval_programming'],
  aerobic_hill_repeats: ['elite_periodization', 'interval_programming'],
  uphill_threshold_repeats: ['elite_periodization', 'interval_programming'],
  fartlek: ['intensity_distribution', 'interval_programming'],
  short_intervals: ['intensity_distribution', 'interval_programming'],
  long_intervals: ['elite_periodization', 'interval_programming'],
  tempo_threshold: ['intensity_distribution', 'elite_periodization'],
  progression_run: ['intensity_distribution', 'elite_periodization'],
  race_pace_intervals: ['elite_periodization', 'interval_programming'],
  sharpening_strides: ['elite_periodization', 'taper_meta_analysis'],
  race: ['elite_periodization', 'taper_meta_analysis', 'ten_mile_time_plan'],
  benchmark_mile: ['interval_programming'],
  recovery: ['intensity_distribution', 'kipchoge_recovery'],
  easy: ['intensity_distribution', 'ten_mile_time_plan'],
  steady: ['intensity_distribution', 'elite_periodization'],
  long: ['intensity_distribution', 'elite_periodization', 'ten_mile_time_plan'],
  hills: ['elite_periodization', 'interval_programming'],
  quality: ['intensity_distribution', 'interval_programming'],
  race_pace: ['elite_periodization', 'interval_programming'],
  sharpen: ['elite_periodization', 'taper_meta_analysis'],
});

function sourceForId(id) {
  const record = SOURCES[id];
  return record ? JSON.parse(JSON.stringify(record)) : null;
}

function runEvidenceRefs(workoutId) {
  return [...(RUN_REFS[String(workoutId || '').toLowerCase()] || RUN_REFS.easy_aerobic)];
}

function strengthEvidenceRefs() {
  return ['strength_running_economy'];
}

function planEvidence(mode) {
  const ids = [
    'intensity_distribution',
    'elite_periodization',
    'interval_programming',
    'taper_meta_analysis',
    'ten_mile_time_plan',
    'ingebrigtsen_progression',
    'kipchoge_recovery',
  ];
  if (String(mode || '') !== 'run_only') ids.push('strength_running_economy');
  return ids.map(sourceForId).filter(Boolean);
}

function validateRegistry() {
  const errors = [];
  const identifiers = new Set();
  Object.entries(SOURCES).forEach(([key, record]) => {
    if (record.id !== key || identifiers.has(record.id)) errors.push(`${key}.id must be unique and stable`);
    identifiers.add(record.id);
    for (const field of ['kind', 'activationStatus', 'title', 'publisher', 'url', 'studyDesign', 'evidenceGrade', 'population', 'principle', 'licenseUsage']) {
      if (!String(record[field] || '').trim()) errors.push(`${key}.${field} is required`);
    }
    for (const field of ['experienceLevels', 'distanceApplicability', 'goalApplicability', 'supportedOutcomes', 'contraindications']) {
      if (!Array.isArray(record[field]) || record[field].length === 0) errors.push(`${key}.${field} is required`);
    }
    if (!/^https:\/\//.test(record.url)) errors.push(`${key}.url must use HTTPS`);
    if (record.executable || record.productionRuleApproved || record.qualifiedReviewer) {
      errors.push(`${key} cannot execute without qualified review`);
    }
  });
  Object.entries(RUN_REFS).forEach(([workoutId, refs]) => {
    refs.forEach((ref) => {
      if (!SOURCES[ref]) errors.push(`${workoutId} references unknown source ${ref}`);
    });
  });
  return { valid: errors.length === 0, errors };
}

module.exports = {
  SOURCES,
  RUN_REFS,
  sourceForId,
  runEvidenceRefs,
  strengthEvidenceRefs,
  planEvidence,
  validateRegistry,
};
