const EVIDENCE_KIND_LABELS = {
  research: 'Research',
  coach_plan: 'Coach plan',
  athlete_practice: 'Athlete practice',
}

export function trainingEvidenceKindLabel(kind) {
  return EVIDENCE_KIND_LABELS[String(kind || '').toLowerCase()] || 'Training reference'
}
