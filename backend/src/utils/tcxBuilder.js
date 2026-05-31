function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncateName(value = '') {
  return escapeXml(String(value || 'Forge Workout').trim().slice(0, 15) || 'Forge Workout');
}

function paceToSpeedTarget(paceTarget = '') {
  const match = String(paceTarget).match(/([0-9]+):([0-9]{2})\s*\/?\s*mi/i);
  if (!match) return '';
  const paceSeconds = (Number(match[1]) * 60) + Number(match[2]);
  if (!Number.isFinite(paceSeconds) || paceSeconds <= 10) return '';
  const low = (1609.344 / (paceSeconds + 10)).toFixed(2);
  const high = (1609.344 / (paceSeconds - 10)).toFixed(2);
  return [
    '<Target xsi:type="Speed_t">',
    '<SpeedZone xsi:type="CustomSpeedZone_t">',
    '<ViewAs>Pace</ViewAs>',
    `<LowInMetersPerSecond>${low}</LowInMetersPerSecond>`,
    `<HighInMetersPerSecond>${high}</HighInMetersPerSecond>`,
    '</SpeedZone>',
    '</Target>',
  ].join('');
}

function durationXml(block = {}) {
  if (block.durationMinutes) {
    return `<Duration xsi:type="Time_t"><Seconds>${Math.round(Number(block.durationMinutes) * 60)}</Seconds></Duration>`;
  }
  if (block.distanceMiles) {
    return `<Duration xsi:type="Distance_t"><Meters>${Math.round(Number(block.distanceMiles) * 1609.344)}</Meters></Duration>`;
  }
  return '<Duration xsi:type="UserInitiated_t"></Duration>';
}

function targetXml(block = {}) {
  if (block.hrZone) {
    return `<Target xsi:type="HeartRateZone_t"><Number>${Number(block.hrZone)}</Number></Target>`;
  }
  return paceToSpeedTarget(block.paceTarget) || '<Target xsi:type="None_t"></Target>';
}

function stepXml(block = {}, index) {
  return [
    '<Step xsi:type="Step_t">',
    `<StepId>${index + 1}</StepId>`,
    `<Name>${truncateName(block.label)}</Name>`,
    durationXml(block),
    `<Intensity>${block.phase === 'cooldown' ? 'Resting' : 'Active'}</Intensity>`,
    targetXml(block),
    '</Step>',
  ].join('');
}

function buildTcxWorkout({ name, structure }) {
  const steps = Array.isArray(structure) ? structure.map(stepXml).join('') : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">',
    '<Workouts>',
    '<Workout Sport="Running">',
    `<Name>${truncateName(name)}</Name>`,
    steps,
    '</Workout>',
    '</Workouts>',
    '</TrainingCenterDatabase>',
  ].join('');
}

module.exports = { buildTcxWorkout };
