import { useEffect, useState } from 'react'

export default function LoadingRunner({ message = 'Loading...' }) {
  const [dots, setDots] = useState('')

  useEffect(() => {
    const t = setInterval(() => setDots(d => d.length >= 3 ? '' : d + '.'), 400)
    return () => clearInterval(t)
  }, [])

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 220,
      gap: 16,
    }}>
      <style>{`
        @keyframes body-bob {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-4px); }
        }
        @keyframes arm-forward {
          0%, 100% { transform: rotate(-40deg); }
          50% { transform: rotate(40deg); }
        }
        @keyframes arm-back {
          0%, 100% { transform: rotate(40deg); }
          50% { transform: rotate(-40deg); }
        }
        @keyframes leg-forward {
          0%, 100% { transform: rotate(-45deg); }
          50% { transform: rotate(45deg); }
        }
        @keyframes leg-back {
          0%, 100% { transform: rotate(45deg); }
          50% { transform: rotate(-45deg); }
        }
        @keyframes calf-forward {
          0%, 100% { transform: rotate(10deg); }
          50% { transform: rotate(-30deg); }
        }
        @keyframes calf-back {
          0%, 100% { transform: rotate(-10deg); }
          50% { transform: rotate(30deg); }
        }
        @keyframes shadow-pulse {
          0%, 100% { transform: scaleX(1); opacity: 0.25; }
          50% { transform: scaleX(0.7); opacity: 0.1; }
        }
        @keyframes track-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-40px); }
        }
        .runner-body { animation: body-bob 0.5s ease-in-out infinite; }
        .arm-l { transform-origin: 2px 2px; animation: arm-forward 0.5s ease-in-out infinite; }
        .arm-r { transform-origin: 2px 2px; animation: arm-back 0.5s ease-in-out infinite; }
        .thigh-l { transform-origin: 2px 2px; animation: leg-forward 0.5s ease-in-out infinite; }
        .thigh-r { transform-origin: 2px 2px; animation: leg-back 0.5s ease-in-out infinite; }
        .calf-l { transform-origin: 2px 2px; animation: calf-forward 0.5s ease-in-out infinite; }
        .calf-r { transform-origin: 2px 2px; animation: calf-back 0.5s ease-in-out infinite; }
        .runner-shadow { transform-origin: center; animation: shadow-pulse 0.5s ease-in-out infinite; }
        .track-line { animation: track-scroll 0.4s linear infinite; }
      `}</style>

      <svg width="140" height="130" viewBox="0 0 140 130" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Shadow */}
        <ellipse className="runner-shadow" cx="70" cy="115" rx="28" ry="5" fill="#EAB308" />

        {/* Track dashes */}
        <g clipPath="url(#track-clip)">
          <g className="track-line">
            {[0, 20, 40, 60, 80, 100, 120, 140, 160].map(x => (
              <rect key={x} x={x} y="119" width="12" height="3" rx="1.5" fill="#EAB308" opacity="0.3" />
            ))}
          </g>
        </g>
        <defs>
          <clipPath id="track-clip">
            <rect x="10" y="116" width="120" height="8" />
          </clipPath>
        </defs>

        {/* Runner group — centered at 70,55 */}
        <g className="runner-body" style={{ transformOrigin: '70px 55px' }}>
          {/* Head */}
          <circle cx="70" cy="30" r="10" fill="#EAB308" />
          {/* Visor */}
          <rect x="62" y="26" width="14" height="4" rx="2" fill="#000" />
          {/* Torso */}
          <rect x="65" y="40" width="10" height="22" rx="4" fill="#EAB308" />

          {/* Left arm (forward swing) */}
          <g className="arm-l" style={{ transformOrigin: '67px 43px' }}>
            <rect x="55" y="43" width="12" height="4" rx="2" fill="#EAB308" />
            {/* Forearm */}
            <rect x="46" y="39" width="10" height="4" rx="2" fill="#EAB308" />
          </g>

          {/* Right arm (back swing) */}
          <g className="arm-r" style={{ transformOrigin: '73px 43px' }}>
            <rect x="73" y="43" width="12" height="4" rx="2" fill="#EAB308" />
            {/* Forearm */}
            <rect x="84" y="39" width="10" height="4" rx="2" fill="#EAB308" />
          </g>

          {/* Left thigh (forward) */}
          <g className="thigh-l" style={{ transformOrigin: '68px 62px' }}>
            <rect x="64" y="62" width="5" height="16" rx="2.5" fill="#EAB308" />
            {/* Left calf */}
            <g className="calf-l" style={{ transformOrigin: '66px 78px' }}>
              <rect x="63" y="78" width="5" height="14" rx="2.5" fill="#EAB308" />
              {/* Shoe */}
              <rect x="60" y="90" width="10" height="4" rx="2" fill="#000" />
            </g>
          </g>

          {/* Right thigh (back) */}
          <g className="thigh-r" style={{ transformOrigin: '72px 62px' }}>
            <rect x="71" y="62" width="5" height="16" rx="2.5" fill="#EAB308" />
            {/* Right calf */}
            <g className="calf-r" style={{ transformOrigin: '73px 78px' }}>
              <rect x="71" y="78" width="5" height="14" rx="2.5" fill="#EAB308" />
              {/* Shoe */}
              <rect x="70" y="90" width="10" height="4" rx="2" fill="#000" />
            </g>
          </g>
        </g>
      </svg>

      <p style={{
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--text-muted)',
        letterSpacing: 1,
        textTransform: 'uppercase',
        minWidth: 100,
        textAlign: 'center',
      }}>
        {message}{dots}
      </p>
    </div>
  )
}
