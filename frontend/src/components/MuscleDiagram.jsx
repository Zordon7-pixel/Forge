// Simple front-view body silhouette with muscle group zones
export default function MuscleDiagram({ muscleGroups = [], sex = 'male', size = 60 }) {
  const active = new Set(muscleGroups.map(m => m.toLowerCase()))

  return (
    <svg width={size} height={size * 1.8} viewBox="0 0 100 180" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="50" cy="10" rx="9" ry="10" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" opacity="0.4" />
      <rect x="46" y="19" width="8" height="5" rx="2" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" opacity="0.4" />
      <rect x="34" y={sex === 'female' ? '24' : '24'} width="32" height="38" rx="6" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" opacity="0.4" />
      <rect x="16" y="25" width="16" height="32" rx="7" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" opacity="0.4" />
      <rect x="68" y="25" width="16" height="32" rx="7" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" opacity="0.4" />
      <rect x="34" y="62" width="13" height="48" rx="6" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" opacity="0.4" />
      <rect x="53" y="62" width="13" height="48" rx="6" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" opacity="0.4" />

      {active.has('chest') && <ellipse cx="50" cy="33" rx="13" ry="7" fill="var(--accent)" opacity="0.7" />}
      {active.has('shoulders') && (
        <>
          <ellipse cx="30" cy="28" rx="7" ry="5" fill="var(--accent)" opacity="0.7" />
          <ellipse cx="70" cy="28" rx="7" ry="5" fill="var(--accent)" opacity="0.7" />
        </>
      )}
      {active.has('back') && <ellipse cx="50" cy="40" rx="11" ry="8" fill="var(--accent)" opacity="0.5" />}
      {active.has('arms') && (
        <>
          <rect x="17" y="26" width="14" height="28" rx="6" fill="var(--accent)" opacity="0.6" />
          <rect x="69" y="26" width="14" height="28" rx="6" fill="var(--accent)" opacity="0.6" />
        </>
      )}
      {active.has('core') && <ellipse cx="50" cy="50" rx="9" ry="9" fill="var(--accent)" opacity="0.7" />}
      {active.has('legs') && (
        <>
          <rect x="35" y="63" width="11" height="44" rx="5" fill="var(--accent)" opacity="0.7" />
          <rect x="54" y="63" width="11" height="44" rx="5" fill="var(--accent)" opacity="0.7" />
        </>
      )}
    </svg>
  )
}
