import React from 'react'

const MUSCLE_HIGHLIGHT_MAP = {
  chest: { front: ['chest-l', 'chest-r'], back: [] },
  back: { front: [], back: ['lat-l', 'lat-r', 'trap-upper', 'trap-lower', 'rhomboid'] },
  legs: { front: ['quad-l', 'quad-r', 'inner-quad-l', 'inner-quad-r'], back: ['hamstring-l', 'hamstring-r', 'glute-l', 'glute-r', 'calf-l', 'calf-r'] },
  shoulders: { front: ['shoulder-front-l', 'shoulder-front-r'], back: ['shoulder-rear-l', 'shoulder-rear-r', 'trap-upper'] },
  arms: { front: ['bicep-l', 'bicep-r', 'forearm-l', 'forearm-r'], back: ['tricep-l', 'tricep-r', 'forearm-l', 'forearm-r'] },
  core: { front: ['abs', 'oblique-l', 'oblique-r'], back: ['lower-back'] }
}

const PRIMARY_COLOR = '#EF4444'
const SECONDARY_COLOR = '#EAB308'
const UNTARGETED_COLOR = 'rgba(255,255,255,0.08)'
const OUTLINE_COLOR = 'rgba(255,255,255,0.15)'

function BodyFront({ primaryIds = [], secondaryIds = [] }) {
  const fill = (id) => {
    if (primaryIds.includes(id)) return PRIMARY_COLOR
    if (secondaryIds.includes(id)) return SECONDARY_COLOR
    return UNTARGETED_COLOR
  }

  return (
    <svg viewBox="0 0 120 280" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      <ellipse cx="60" cy="30" rx="18" ry="22" fill={UNTARGETED_COLOR} stroke={OUTLINE_COLOR} strokeWidth="1" />
      <rect x="54" y="50" width="12" height="14" rx="4" fill={UNTARGETED_COLOR} stroke={OUTLINE_COLOR} strokeWidth="1" />
      <path d="M30 64 Q25 70 24 90 L24 150 Q24 158 30 162 L90 162 Q96 158 96 150 L96 90 Q95 70 90 64 Z" fill={UNTARGETED_COLOR} stroke={OUTLINE_COLOR} strokeWidth="1" />

      <ellipse id="shoulder-front-l" cx="22" cy="76" rx="11" ry="9" fill={fill('shoulder-front-l')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <ellipse id="shoulder-front-r" cx="98" cy="76" rx="11" ry="9" fill={fill('shoulder-front-r')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />

      <path id="chest-l" d="M30 68 Q35 65 55 68 L55 100 Q48 105 30 100 Z" fill={fill('chest-l')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <path id="chest-r" d="M90 68 Q85 65 65 68 L65 100 Q72 105 90 100 Z" fill={fill('chest-r')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />

      <rect id="abs" x="47" y="105" width="26" height="45" rx="4" fill={fill('abs')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />

      <path id="oblique-l" d="M30 100 Q35 105 47 108 L47 148 Q40 150 28 142 Z" fill={fill('oblique-l')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <path id="oblique-r" d="M90 100 Q85 105 73 108 L73 148 Q80 150 92 142 Z" fill={fill('oblique-r')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />

      <rect id="bicep-l" x="8" y="88" width="11" height="38" rx="5" fill={fill('bicep-l')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <rect id="bicep-r" x="101" y="88" width="11" height="38" rx="5" fill={fill('bicep-r')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />

      <rect id="forearm-l" x="6" y="130" width="10" height="36" rx="4" fill={fill('forearm-l')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <rect id="forearm-r" x="104" y="130" width="10" height="36" rx="4" fill={fill('forearm-r')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />

      <path d="M28 158 Q24 172 26 185 L42 185 Q46 172 46 160 Z" fill={UNTARGETED_COLOR} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <path d="M92 158 Q96 172 94 185 L78 185 Q74 172 74 160 Z" fill={UNTARGETED_COLOR} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />

      <path id="quad-l" d="M27 187 Q24 200 26 230 L42 230 Q44 200 43 187 Z" fill={fill('quad-l')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <path id="quad-r" d="M93 187 Q96 200 94 230 L78 230 Q76 200 77 187 Z" fill={fill('quad-r')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <path id="inner-quad-l" d="M43 187 Q46 200 46 230 L54 230 Q54 200 50 187 Z" fill={fill('inner-quad-l')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <path id="inner-quad-r" d="M77 187 Q74 200 74 230 L66 230 Q66 200 70 187 Z" fill={fill('inner-quad-r')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />

      <ellipse cx="35" cy="234" rx="10" ry="6" fill={UNTARGETED_COLOR} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <ellipse cx="85" cy="234" rx="10" ry="6" fill={UNTARGETED_COLOR} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />

      <path d="M26 240 Q25 255 26 275 L44 275 Q45 255 44 240 Z" fill={UNTARGETED_COLOR} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <path d="M76 240 Q75 255 76 275 L94 275 Q95 255 94 240 Z" fill={UNTARGETED_COLOR} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
    </svg>
  )
}

function BodyBack({ primaryIds = [], secondaryIds = [] }) {
  const fill = (id) => {
    if (primaryIds.includes(id)) return PRIMARY_COLOR
    if (secondaryIds.includes(id)) return SECONDARY_COLOR
    return UNTARGETED_COLOR
  }

  return (
    <svg viewBox="0 0 120 280" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      <ellipse cx="60" cy="30" rx="18" ry="22" fill={UNTARGETED_COLOR} stroke={OUTLINE_COLOR} strokeWidth="1" />
      <rect x="54" y="50" width="12" height="14" rx="4" fill={UNTARGETED_COLOR} stroke={OUTLINE_COLOR} strokeWidth="1" />
      <path d="M30 64 Q25 70 24 90 L24 150 Q24 158 30 162 L90 162 Q96 158 96 150 L96 90 Q95 70 90 64 Z" fill={UNTARGETED_COLOR} stroke={OUTLINE_COLOR} strokeWidth="1" />

      <ellipse id="shoulder-rear-l" cx="22" cy="76" rx="11" ry="9" fill={fill('shoulder-rear-l')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <ellipse id="shoulder-rear-r" cx="98" cy="76" rx="11" ry="9" fill={fill('shoulder-rear-r')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />

      <path id="trap-upper" d="M36 64 Q60 58 84 64 L84 80 Q60 76 36 80 Z" fill={fill('trap-upper')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <path id="trap-lower" d="M36 80 Q60 76 84 80 L80 110 Q60 115 40 110 Z" fill={fill('trap-lower')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <path id="rhomboid" d="M40 82 Q60 78 80 82 L76 108 Q60 112 44 108 Z" fill={fill('rhomboid')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" opacity="0.7" />

      <path id="lat-l" d="M28 82 Q32 90 34 130 L48 130 Q46 95 40 82 Z" fill={fill('lat-l')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <path id="lat-r" d="M92 82 Q88 90 86 130 L72 130 Q74 95 80 82 Z" fill={fill('lat-r')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />

      <rect id="lower-back" x="40" y="120" width="40" height="38" rx="4" fill={fill('lower-back')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />

      <rect id="tricep-l" x="8" y="88" width="11" height="38" rx="5" fill={fill('tricep-l')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <rect id="tricep-r" x="101" y="88" width="11" height="38" rx="5" fill={fill('tricep-r')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />

      <rect id="forearm-l" x="6" y="130" width="10" height="36" rx="4" fill={fill('forearm-l')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <rect id="forearm-r" x="104" y="130" width="10" height="36" rx="4" fill={fill('forearm-r')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />

      <path id="glute-l" d="M28 162 Q26 178 28 195 L56 195 Q56 178 50 162 Z" fill={fill('glute-l')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <path id="glute-r" d="M92 162 Q94 178 92 195 L64 195 Q64 178 70 162 Z" fill={fill('glute-r')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />

      <path id="hamstring-l" d="M28 197 Q26 214 28 232 L50 232 Q52 214 54 197 Z" fill={fill('hamstring-l')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <path id="hamstring-r" d="M92 197 Q94 214 92 232 L70 232 Q68 214 66 197 Z" fill={fill('hamstring-r')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />

      <path id="calf-l" d="M28 235 Q26 250 28 270 L48 270 Q50 250 50 235 Z" fill={fill('calf-l')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <path id="calf-r" d="M92 235 Q94 250 92 270 L72 270 Q70 250 70 235 Z" fill={fill('calf-r')} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
    </svg>
  )
}

export default function MuscleDiagram({ primaryMuscles = [], secondaryMuscles = [] }) {
  const normalizedPrimary = primaryMuscles.map((m) => String(m).toLowerCase())
  const normalizedSecondary = secondaryMuscles.map((m) => String(m).toLowerCase())

  const getIds = (groups, view) => {
    const ids = []
    for (const key of groups) {
      const mapped = MUSCLE_HIGHLIGHT_MAP[key]
      if (mapped) ids.push(...(mapped[view] || []))
    }
    return [...new Set(ids)]
  }

  const frontPrimary = getIds(normalizedPrimary, 'front')
  const backPrimary = getIds(normalizedPrimary, 'back')
  const frontSecondary = getIds(normalizedSecondary, 'front').filter((id) => !frontPrimary.includes(id))
  const backSecondary = getIds(normalizedSecondary, 'back').filter((id) => !backPrimary.includes(id))

  return (
    <div>
      <div className="flex gap-4 justify-center">
        <div className="flex flex-col items-center gap-1 flex-1">
          <span className="text-xs font-medium" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>Front</span>
          <div className="h-48 w-full">
            <BodyFront primaryIds={frontPrimary} secondaryIds={frontSecondary} />
          </div>
        </div>
        <div className="flex flex-col items-center gap-1 flex-1">
          <span className="text-xs font-medium" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>Back</span>
          <div className="h-48 w-full">
            <BodyBack primaryIds={backPrimary} secondaryIds={backSecondary} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 20, marginTop: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#EF4444' }} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Primary</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#EAB308' }} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Secondary</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgba(255,255,255,0.2)' }} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Untargeted</span>
        </div>
      </div>
    </div>
  )
}
