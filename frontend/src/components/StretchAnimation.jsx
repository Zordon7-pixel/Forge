import React from 'react'

const B = '#374151'   // body color (dark gray)
const A = '#EAB308'   // accent / highlighted limb (yellow)

/* ─── keyframe CSS strings ─── */
const KF = {
  quad: `
    @keyframes quadBend {
      0%,100% { transform: rotate(-20deg); }
      50%      { transform: rotate(-120deg); }
    }
  `,
  hamstring: `
    @keyframes torsoFwd {
      0%,100% { transform: rotate(0deg); }
      50%      { transform: rotate(38deg); }
    }
  `,
  'hip-flexor': `
    @keyframes hipSway {
      0%,100% { transform: translateX(0px) translateY(0px); }
      50%      { transform: translateX(-5px) translateY(-3px); }
    }
  `,
  calf: `
    @keyframes ankleFlx {
      0%,100% { transform: rotate(0deg); }
      50%      { transform: rotate(-28deg); }
    }
  `,
  shoulder: `
    @keyframes armAcross {
      0%,100% { transform: rotate(0deg); }
      40%,60% { transform: rotate(-52deg); }
    }
  `,
  neck: `
    @keyframes neckTilt {
      0%,100% { transform: rotate(0deg); }
      30%      { transform: rotate(20deg); }
      70%      { transform: rotate(-20deg); }
    }
  `,
  trunk: `
    @keyframes trunkTwist {
      0%,100% { transform: rotate(0deg); }
      40%      { transform: rotate(22deg); }
      60%      { transform: rotate(-22deg); }
    }
  `,
  'childs-pose': `
    @keyframes childRock {
      0%,100% { transform: rotate(0deg); }
      50%      { transform: rotate(18deg); }
    }
  `,
}

/* ─── SVG figures ─── */

function QuadFigure() {
  // Front view, standing, right lower leg bends back (quad stretch)
  const animStyle = {
    animation: 'quadBend 3s ease-in-out infinite',
    transformOrigin: '74px 108px',
  }
  return (
    <>
      {/* Head */}
      <circle cx="58" cy="18" r="9" fill={B} />
      {/* Torso */}
      <rect x="46" y="28" width="24" height="42" rx="6" fill={B} />
      {/* Left arm – relaxed at side */}
      <line x1="46" y1="34" x2="30" y2="62" stroke={B} strokeWidth="5" strokeLinecap="round" />
      {/* Right arm – raised/bent to hold foot */}
      <line x1="70" y1="34" x2="86" y2="50" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <line x1="86" y1="50" x2="86" y2="88" stroke={B} strokeWidth="4" strokeLinecap="round" />
      {/* Left upper leg */}
      <line x1="52" y1="70" x2="48" y2="110" stroke={B} strokeWidth="5" strokeLinecap="round" />
      {/* Left lower leg + foot */}
      <line x1="48" y1="110" x2="44" y2="148" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <line x1="44" y1="148" x2="34" y2="150" stroke={B} strokeWidth="4" strokeLinecap="round" />
      {/* Right upper leg */}
      <line x1="64" y1="70" x2="74" y2="108" stroke={B} strokeWidth="5" strokeLinecap="round" />
      {/* Right lower leg – animated (bends back) */}
      <g style={animStyle}>
        <line x1="74" y1="108" x2="78" y2="146" stroke={A} strokeWidth="5" strokeLinecap="round" />
        <line x1="78" y1="146" x2="88" y2="142" stroke={A} strokeWidth="4" strokeLinecap="round" />
      </g>
    </>
  )
}

function HamstringFigure() {
  // Side view, seated, torso rocks forward toward extended leg
  // Hip pivot at (60, 118)
  const animStyle = {
    animation: 'torsoFwd 3.5s ease-in-out infinite',
    transformOrigin: '60px 118px',
  }
  return (
    <>
      {/* Ground line */}
      <line x1="10" y1="148" x2="110" y2="148" stroke="#4B5563" strokeWidth="2" />
      {/* Seated upper body (animated) */}
      <g style={animStyle}>
        {/* Torso */}
        <line x1="60" y1="118" x2="60" y2="80" stroke={B} strokeWidth="9" strokeLinecap="round" />
        {/* Head */}
        <circle cx="60" cy="70" r="9" fill={B} />
        {/* Left arm reaching toward foot */}
        <line x1="55" y1="92" x2="32" y2="130" stroke={A} strokeWidth="4" strokeLinecap="round" />
        {/* Right arm reaching toward foot */}
        <line x1="65" y1="92" x2="88" y2="130" stroke={A} strokeWidth="4" strokeLinecap="round" />
      </g>
      {/* Extended left leg (on ground) */}
      <line x1="54" y1="118" x2="26" y2="148" stroke={A} strokeWidth="5" strokeLinecap="round" />
      {/* Foot */}
      <line x1="26" y1="148" x2="14" y2="145" stroke={A} strokeWidth="4" strokeLinecap="round" />
      {/* Bent right leg (sole on ground) */}
      <line x1="66" y1="118" x2="86" y2="148" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <line x1="86" y1="148" x2="102" y2="140" stroke={B} strokeWidth="4" strokeLinecap="round" />
    </>
  )
}

function HipFlexorFigure() {
  // Side view, lunge: front leg (left) bent ~90°, back leg extended with knee near ground
  // Whole upper body group sways slightly forward/back
  const animStyle = {
    animation: 'hipSway 3s ease-in-out infinite',
  }
  return (
    <>
      {/* Ground line */}
      <line x1="10" y1="152" x2="110" y2="152" stroke="#4B5563" strokeWidth="2" />
      {/* Back knee on ground */}
      <line x1="80" y1="118" x2="96" y2="152" stroke={B} strokeWidth="5" strokeLinecap="round" />
      {/* Back upper leg to hip */}
      <line x1="60" y1="85" x2="80" y2="118" stroke={B} strokeWidth="5" strokeLinecap="round" />
      {/* Front upper leg (forward, bent) */}
      <line x1="52" y1="85" x2="36" y2="118" stroke={A} strokeWidth="5" strokeLinecap="round" />
      {/* Front lower leg (knee to foot on ground) */}
      <line x1="36" y1="118" x2="28" y2="152" stroke={A} strokeWidth="5" strokeLinecap="round" />
      {/* Front foot */}
      <line x1="28" y1="152" x2="14" y2="150" stroke={A} strokeWidth="4" strokeLinecap="round" />

      {/* Torso / head group – sways */}
      <g style={animStyle}>
        <rect x="48" y="48" width="22" height="38" rx="6" fill={B} />
        <circle cx="59" cy="38" r="9" fill={B} />
        {/* Left arm up */}
        <line x1="48" y1="56" x2="32" y2="40" stroke={B} strokeWidth="4" strokeLinecap="round" />
        {/* Right arm up */}
        <line x1="70" y1="56" x2="86" y2="40" stroke={B} strokeWidth="4" strokeLinecap="round" />
      </g>
    </>
  )
}

function CalfFigure() {
  // Side view, standing, back leg heel flat, front hand on wall (lean)
  // Foot/ankle animates (dorsiflexion)
  const animStyle = {
    animation: 'ankleFlx 3s ease-in-out infinite',
    transformOrigin: '62px 142px',
  }
  return (
    <>
      {/* Wall */}
      <rect x="14" y="20" width="8" height="132" rx="3" fill="#374151" opacity="0.5" />
      {/* Ground line */}
      <line x1="10" y1="152" x2="110" y2="152" stroke="#4B5563" strokeWidth="2" />
      {/* Head */}
      <circle cx="68" cy="22" r="9" fill={B} />
      {/* Torso leaning forward */}
      <line x1="68" y1="31" x2="58" y2="75" stroke={B} strokeWidth="9" strokeLinecap="round" />
      {/* Front arm (pushing wall) */}
      <line x1="62" y1="45" x2="28" y2="48" stroke={B} strokeWidth="5" strokeLinecap="round" />
      {/* Other arm */}
      <line x1="70" y1="48" x2="84" y2="36" stroke={B} strokeWidth="4" strokeLinecap="round" />
      {/* Front leg (near wall) */}
      <line x1="58" y1="75" x2="54" y2="112" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <line x1="54" y1="112" x2="50" y2="152" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <line x1="50" y1="152" x2="36" y2="150" stroke={B} strokeWidth="4" strokeLinecap="round" />
      {/* Back leg – upper */}
      <line x1="62" y1="75" x2="66" y2="112" stroke={A} strokeWidth="5" strokeLinecap="round" />
      <line x1="66" y1="112" x2="62" y2="142" stroke={A} strokeWidth="5" strokeLinecap="round" />
      {/* Back foot – animated (dorsiflexion) */}
      <g style={animStyle}>
        <line x1="62" y1="142" x2="80" y2="152" stroke={A} strokeWidth="4" strokeLinecap="round" />
      </g>
    </>
  )
}

function ShoulderFigure() {
  // Front view, standing. Right arm sweeps across chest
  const animStyle = {
    animation: 'armAcross 3.5s ease-in-out infinite',
    transformOrigin: '68px 38px',
  }
  return (
    <>
      {/* Head */}
      <circle cx="60" cy="18" r="9" fill={B} />
      {/* Torso */}
      <rect x="46" y="28" width="24" height="42" rx="6" fill={B} />
      {/* Left arm at side */}
      <line x1="46" y1="34" x2="30" y2="62" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <line x1="30" y1="62" x2="22" y2="78" stroke={B} strokeWidth="4" strokeLinecap="round" />
      {/* Left arm helping pull – static, across chest */}
      <line x1="46" y1="48" x2="60" y2="52" stroke={B} strokeWidth="4" strokeLinecap="round" />
      {/* Right arm – animated across chest */}
      <g style={animStyle}>
        <line x1="68" y1="38" x2="94" y2="52" stroke={A} strokeWidth="5" strokeLinecap="round" />
        <line x1="94" y1="52" x2="104" y2="62" stroke={A} strokeWidth="4" strokeLinecap="round" />
      </g>
      {/* Left leg */}
      <line x1="52" y1="70" x2="48" y2="110" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <line x1="48" y1="110" x2="44" y2="148" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <line x1="44" y1="148" x2="34" y2="150" stroke={B} strokeWidth="4" strokeLinecap="round" />
      {/* Right leg */}
      <line x1="68" y1="70" x2="72" y2="110" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <line x1="72" y1="110" x2="76" y2="148" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <line x1="76" y1="148" x2="86" y2="150" stroke={B} strokeWidth="4" strokeLinecap="round" />
    </>
  )
}

function NeckFigure() {
  // Front view, standing. Head group tilts side to side
  const animStyle = {
    animation: 'neckTilt 3s ease-in-out infinite',
    transformOrigin: '60px 30px',
  }
  return (
    <>
      {/* Head group – animated */}
      <g style={animStyle}>
        <circle cx="60" cy="18" r="9" fill={A} />
        <line x1="60" y1="27" x2="60" y2="32" stroke={A} strokeWidth="3" strokeLinecap="round" />
      </g>
      {/* Torso */}
      <rect x="46" y="32" width="24" height="42" rx="6" fill={B} />
      {/* Left arm */}
      <line x1="46" y1="38" x2="30" y2="60" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <line x1="30" y1="60" x2="22" y2="74" stroke={B} strokeWidth="4" strokeLinecap="round" />
      {/* Right arm */}
      <line x1="70" y1="38" x2="86" y2="60" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <line x1="86" y1="60" x2="94" y2="74" stroke={B} strokeWidth="4" strokeLinecap="round" />
      {/* Left leg */}
      <line x1="52" y1="74" x2="48" y2="112" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <line x1="48" y1="112" x2="44" y2="150" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <line x1="44" y1="150" x2="34" y2="152" stroke={B} strokeWidth="4" strokeLinecap="round" />
      {/* Right leg */}
      <line x1="68" y1="74" x2="72" y2="112" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <line x1="72" y1="112" x2="76" y2="150" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <line x1="76" y1="150" x2="86" y2="152" stroke={B} strokeWidth="4" strokeLinecap="round" />
    </>
  )
}

function TrunkFigure() {
  // Front view, seated cross-legged. Upper body (torso + head + arms) twists
  const animStyle = {
    animation: 'trunkTwist 3.5s ease-in-out infinite',
    transformOrigin: '60px 92px',
  }
  return (
    <>
      {/* Ground line */}
      <line x1="10" y1="148" x2="110" y2="148" stroke="#4B5563" strokeWidth="2" />
      {/* Crossed legs – static */}
      {/* Left thigh going out-left */}
      <line x1="54" y1="118" x2="30" y2="140" stroke={B} strokeWidth="5" strokeLinecap="round" />
      {/* Right thigh going out-right */}
      <line x1="66" y1="118" x2="90" y2="140" stroke={B} strokeWidth="5" strokeLinecap="round" />
      {/* Cross feet */}
      <line x1="30" y1="140" x2="60" y2="148" stroke={B} strokeWidth="4" strokeLinecap="round" />
      <line x1="90" y1="140" x2="60" y2="148" stroke={B} strokeWidth="4" strokeLinecap="round" />

      {/* Upper body – animated twist */}
      <g style={animStyle}>
        <rect x="47" y="80" width="26" height="38" rx="6" fill={B} />
        <circle cx="60" cy="70" r="9" fill={B} />
        {/* Left arm twisting out */}
        <line x1="47" y1="88" x2="24" y2="100" stroke={A} strokeWidth="5" strokeLinecap="round" />
        <line x1="24" y1="100" x2="16" y2="112" stroke={A} strokeWidth="4" strokeLinecap="round" />
        {/* Right arm */}
        <line x1="73" y1="88" x2="92" y2="104" stroke={B} strokeWidth="5" strokeLinecap="round" />
      </g>
    </>
  )
}

function ChildsPoseFigure() {
  // Side view, kneeled, arms extended forward, torso rocks toward floor
  // Upper body (head + torso + arms) pivot at hip/knee level
  const animStyle = {
    animation: 'childRock 3.5s ease-in-out infinite',
    transformOrigin: '72px 118px',
  }
  return (
    <>
      {/* Ground line */}
      <line x1="10" y1="148" x2="110" y2="148" stroke="#4B5563" strokeWidth="2" />
      {/* Feet/shins on ground */}
      <line x1="72" y1="118" x2="92" y2="148" stroke={B} strokeWidth="5" strokeLinecap="round" />
      {/* Upper thighs */}
      <line x1="60" y1="104" x2="72" y2="118" stroke={B} strokeWidth="5" strokeLinecap="round" />
      {/* Upper body – animated rocking forward */}
      <g style={animStyle}>
        {/* Torso */}
        <line x1="60" y1="104" x2="40" y2="82" stroke={B} strokeWidth="9" strokeLinecap="round" />
        {/* Head */}
        <circle cx="34" cy="74" r="9" fill={B} />
        {/* Arms extended forward along ground */}
        <line x1="48" y1="94" x2="22" y2="118" stroke={A} strokeWidth="5" strokeLinecap="round" />
        <line x1="22" y1="118" x2="10" y2="138" stroke={A} strokeWidth="4" strokeLinecap="round" />
        {/* Other arm */}
        <line x1="44" y1="96" x2="20" y2="122" stroke={A} strokeWidth="4" strokeLinecap="round" opacity="0.5" />
      </g>
    </>
  )
}

const FIGURES = {
  quad: QuadFigure,
  hamstring: HamstringFigure,
  'hip-flexor': HipFlexorFigure,
  calf: CalfFigure,
  shoulder: ShoulderFigure,
  neck: NeckFigure,
  trunk: TrunkFigure,
  'childs-pose': ChildsPoseFigure,
}

export default function StretchAnimation({ stretchId, style }) {
  const id = stretchId || 'neck'
  const Figure = FIGURES[id] || NeckFigure
  const keyframes = KF[id] || ''

  return (
    <div style={{ width: '100%', height: '100%', ...style }}>
      <style>{keyframes}</style>
      <svg
        viewBox="0 0 120 180"
        width="100%"
        height="100%"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: 'block' }}
      >
        <Figure />
      </svg>
    </div>
  )
}
