export default function MuscleDiagram({ muscleGroups = [], primaryGroups = [], secondaryLabels = [], sex = 'male', size = 70 }) {
  // muscleGroups = all groups targeted (for backward compat)
  // primaryGroups = muscle group keys that are primary (bright yellow)
  // secondaryLabels = string labels that map to zones (dimmer yellow)

  const active = new Set([...muscleGroups, ...primaryGroups].map(m => m.toLowerCase()))

  // Map secondary label strings to zones
  const secondaryZones = new Set()
  secondaryLabels.forEach(label => {
    const l = label.toLowerCase()
    if (l.includes('tricep') || l.includes('arm')) secondaryZones.add('arms')
    if (l.includes('shoulder')) secondaryZones.add('shoulders')
    if (l.includes('bicep')) secondaryZones.add('arms')
    if (l.includes('core') || l.includes('ab') || l.includes('oblique')) secondaryZones.add('core')
    if (l.includes('back') || l.includes('trap')) secondaryZones.add('back')
    if (l.includes('chest')) secondaryZones.add('chest')
    if (l.includes('leg') || l.includes('quad') || l.includes('hamstring') || l.includes('glute') || l.includes('calf')) secondaryZones.add('legs')
  })
  // Don't show secondary for zones that are already primary
  active.forEach(z => secondaryZones.delete(z))

  return (
    <svg width={size} height={size * 1.8} viewBox="0 0 100 180" xmlns="http://www.w3.org/2000/svg">
      {/* Body outline */}
      <ellipse cx="50" cy="10" rx="9" ry="10" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" opacity="0.3" />
      <rect x="46" y="19" width="8" height="5" rx="2" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" opacity="0.3" />
      <rect x="34" y="24" width="32" height="38" rx="6" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" opacity="0.3" />
      <rect x="16" y="25" width="16" height="32" rx="7" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" opacity="0.3" />
      <rect x="68" y="25" width="16" height="32" rx="7" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" opacity="0.3" />
      <rect x="34" y="62" width="13" height="48" rx="6" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" opacity="0.3" />
      <rect x="53" y="62" width="13" height="48" rx="6" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" opacity="0.3" />

      {/* Secondary highlights (dim) */}
      {secondaryZones.has('chest') && <ellipse cx="50" cy="33" rx="13" ry="7" fill="var(--accent)" opacity="0.25" />}
      {secondaryZones.has('shoulders') && <>
        <ellipse cx="30" cy="28" rx="7" ry="5" fill="var(--accent)" opacity="0.25" />
        <ellipse cx="70" cy="28" rx="7" ry="5" fill="var(--accent)" opacity="0.25" />
      </>}
      {secondaryZones.has('back') && <ellipse cx="50" cy="40" rx="11" ry="8" fill="var(--accent)" opacity="0.2" />}
      {secondaryZones.has('arms') && <>
        <rect x="17" y="26" width="14" height="28" rx="6" fill="var(--accent)" opacity="0.25" />
        <rect x="69" y="26" width="14" height="28" rx="6" fill="var(--accent)" opacity="0.25" />
      </>}
      {secondaryZones.has('core') && <ellipse cx="50" cy="50" rx="9" ry="9" fill="var(--accent)" opacity="0.25" />}
      {secondaryZones.has('legs') && <>
        <rect x="35" y="63" width="11" height="44" rx="5" fill="var(--accent)" opacity="0.25" />
        <rect x="54" y="63" width="11" height="44" rx="5" fill="var(--accent)" opacity="0.25" />
      </>}

      {/* Primary highlights (bright) */}
      {active.has('chest') && <ellipse cx="50" cy="33" rx="13" ry="7" fill="var(--accent)" opacity="0.8" />}
      {active.has('shoulders') && <>
        <ellipse cx="30" cy="28" rx="7" ry="5" fill="var(--accent)" opacity="0.8" />
        <ellipse cx="70" cy="28" rx="7" ry="5" fill="var(--accent)" opacity="0.8" />
      </>}
      {active.has('back') && <ellipse cx="50" cy="40" rx="11" ry="8" fill="var(--accent)" opacity="0.7" />}
      {active.has('arms') && <>
        <rect x="17" y="26" width="14" height="28" rx="6" fill="var(--accent)" opacity="0.75" />
        <rect x="69" y="26" width="14" height="28" rx="6" fill="var(--accent)" opacity="0.75" />
      </>}
      {active.has('core') && <ellipse cx="50" cy="50" rx="9" ry="9" fill="var(--accent)" opacity="0.8" />}
      {active.has('legs') && <>
        <rect x="35" y="63" width="11" height="44" rx="5" fill="var(--accent)" opacity="0.8" />
        <rect x="54" y="63" width="11" height="44" rx="5" fill="var(--accent)" opacity="0.8" />
      </>}
    </svg>
  )
}
