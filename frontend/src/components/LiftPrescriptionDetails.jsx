// Keep targets visible at handoff and execution without overwriting logged load.
export default function LiftPrescriptionDetails({ exercise = {}, fontSize = 14 }) {
  const fields = [['Load', exercise.load], ['Effort', exercise.rpe || exercise.rir],
    ['Load basis', exercise.loadSource || exercise.load_source], ['Progression', exercise.progression]]
    .filter(([, value]) => typeof value === 'string' && value.trim())
  if (!fields.length) return null
  return <dl style={{ margin: '10px 0 0', display: 'grid', gap: 6, fontSize, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
    {fields.map(([label, value]) => <div key={label}>
      <dt style={{ display: 'inline', fontWeight: 700 }}>{label}: </dt>
      <dd style={{ display: 'inline', margin: 0, color: 'var(--text-muted)' }}>{value}</dd>
    </div>)}
  </dl>
}
