import { useEffect, useRef, useState } from 'react'

// Forged Hybrid signature moment: the app mark drops like a hammer, lands with
// sparks + shake, "FORGED, NOT FINISHED." stamps in, then the overlay hands
// back to the screen underneath. Purely presentational — tap to skip.
// Hex required throughout: canvas + keyframes, no CSS vars in SVG/canvas paths.

const STRIKE_STYLES = `
@keyframes fsLogodrop {
  0%  { opacity:0; transform:translateY(-620px) scale(1.55) rotate(-8deg); }
  12% { opacity:1; }
  100%{ opacity:1; transform:translateY(0) scale(1) rotate(0deg); }
}
@keyframes fsLogoland {
  0%   { opacity:1; transform:translateY(0) scale(1.16,.84); filter:drop-shadow(0 0 64px rgba(255,246,220,.95)); }
  55%  { transform:scale(.97,1.03); }
  100% { opacity:1; transform:scale(1); filter:drop-shadow(0 0 28px rgba(249,115,22,.55)); }
}
@keyframes fsFlashout { 0% { opacity:1; } 100% { opacity:0; } }
@keyframes fsShake {
  0%,100% { transform:translate(0,0); }
  15% { transform:translate(-7px,4px) rotate(-.5deg); }
  30% { transform:translate(6px,-5px) rotate(.4deg); }
  45% { transform:translate(-5px,3px); }
  60% { transform:translate(4px,-3px); }
  75% { transform:translate(-2px,2px); }
}
@keyframes fsStamp {
  0% { opacity:0; transform:scale(2.1) rotate(-2deg); }
  62% { opacity:1; transform:scale(.96); }
  100% { opacity:1; transform:scale(1); }
}
@keyframes fsFadeup {
  0% { opacity:0; transform:translateY(10px); }
  100% { opacity:1; transform:translateY(0); }
}
`

export default function ForgedStrike({ subline = 'RUN COMPLETE', onDone }) {
  const canvasRef = useRef(null)
  const doneRef = useRef(false)
  const [struck, setStruck] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const reducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches

  const finish = () => {
    if (doneRef.current) return
    doneRef.current = true
    setLeaving(true)
    window.setTimeout(() => onDone?.(), 320)
  }

  useEffect(() => {
    const impactMs = reducedMotion ? 60 : 620
    const totalMs = reducedMotion ? 1700 : 2900
    let raf = 0
    let parts = []

    const impactTimer = window.setTimeout(() => {
      setStruck(true)
      const canvas = canvasRef.current
      if (canvas && !reducedMotion) {
        canvas.width = canvas.clientWidth
        canvas.height = canvas.clientHeight
        const ctx = canvas.getContext('2d')
        const cx = canvas.width * 0.5
        const cy = Math.min(canvas.height * 0.72, canvas.height / 2 + 205)
        for (let i = 0; i < 90; i += 1) {
          const angle = -Math.PI * (0.12 + Math.random() * 0.76)
          const speed = 4 + Math.random() * 13
          parts.push({
            x: cx, y: cy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
            life: 1, decay: 0.012 + Math.random() * 0.03,
            width: 1.5 + Math.random() * 2.5, hot: Math.random() > 0.6,
          })
        }
        // lightning flash instead of a shockwave ring: jagged bolts radiating
        // from the impact point, flickering out over ~0.4s
        let bolts = []
        for (let b = 0; b < 6; b += 1) {
          const baseAngle = (Math.PI * 2 * b) / 6 + (Math.random() - 0.5) * 0.9
          const points = [[cx, cy]]
          let px = cx
          let py = cy
          let heading = baseAngle
          const segments = 7 + Math.floor(Math.random() * 5)
          for (let s = 0; s < segments; s += 1) {
            heading += (Math.random() - 0.5) * 1.1
            const length = 16 + Math.random() * 26
            px += Math.cos(heading) * length
            py += Math.sin(heading) * length
            points.push([px, py])
          }
          bolts.push({ points, life: 1, decay: 0.07 + Math.random() * 0.05 })
        }
        const tick = () => {
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          bolts = bolts.filter((bolt) => bolt.life > 0)
          for (const bolt of bolts) {
            bolt.life -= bolt.decay
            const flicker = bolt.life * (0.65 + Math.random() * 0.35)
            ctx.save()
            ctx.lineJoin = 'round'
            ctx.shadowColor = '#F97316'
            ctx.shadowBlur = 18
            ctx.strokeStyle = `rgba(234,179,8,${flicker * 0.7})`
            ctx.lineWidth = 5
            ctx.beginPath()
            bolt.points.forEach(([bx, by], index) => (index ? ctx.lineTo(bx, by) : ctx.moveTo(bx, by)))
            ctx.stroke()
            ctx.shadowBlur = 0
            ctx.strokeStyle = `rgba(255,246,220,${flicker})`
            ctx.lineWidth = 2
            ctx.stroke()
            ctx.restore()
          }
          parts = parts.filter((p) => p.life > 0)
          for (const p of parts) {
            p.x += p.vx; p.y += p.vy; p.vy += 0.34; p.vx *= 0.985; p.life -= p.decay
            ctx.strokeStyle = p.hot
              ? `rgba(255,246,220,${p.life})`
              : `rgba(${234 + Math.floor(21 * p.life)},${140 + Math.floor(79 * p.life)},8,${p.life})`
            ctx.lineWidth = p.width
            ctx.beginPath()
            ctx.moveTo(p.x, p.y)
            ctx.lineTo(p.x - p.vx * 1.8, p.y - p.vy * 1.8)
            ctx.stroke()
          }
          if (parts.length > 0 || bolts.length > 0) raf = window.requestAnimationFrame(tick)
        }
        raf = window.requestAnimationFrame(tick)
      }
    }, impactMs)
    const doneTimer = window.setTimeout(finish, totalMs)
    return () => {
      window.clearTimeout(impactTimer)
      window.clearTimeout(doneTimer)
      window.cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      role="status"
      aria-label="Run forged"
      onClick={finish}
      className="fixed inset-0 z-[80] cursor-pointer overflow-hidden"
      style={{ background: '#070503', opacity: leaving ? 0 : 1, transition: 'opacity 300ms ease-out', animation: struck && !reducedMotion ? 'fsShake .38s linear' : 'none' }}
    >
      <style>{STRIKE_STYLES}</style>
      <div style={{ position: 'absolute', left: '50%', top: '58%', width: 560, height: 560, transform: 'translate(-50%,-50%)', background: 'radial-gradient(circle, rgba(249,115,22,0.30) 0%, rgba(160,58,16,0.14) 38%, transparent 68%)' }} />
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: 190, height: 190, transform: 'translate(-50%, -42%)' }}>
        <img
          src="/icon-192.png"
          alt=""
          style={{
            width: '100%', height: '100%', borderRadius: 44, opacity: 0,
            transform: 'translateY(-620px) scale(1.55) rotate(-8deg)',
            animation: reducedMotion
              ? 'fsFadeup .5s ease-out forwards'
              : struck ? 'fsLogoland .6s cubic-bezier(.2,1.5,.35,1) forwards' : 'fsLogodrop .62s cubic-bezier(.55,0,.95,.45) forwards',
          }}
        />
      </div>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
      {struck && !reducedMotion && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(circle at 50% 62%, rgba(255,246,220,.95), rgba(249,115,22,.35) 40%, transparent 70%)', animation: 'fsFlashout .46s ease-out forwards' }} />
      )}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 'max(84px, 12%)', textAlign: 'center', pointerEvents: 'none' }}>
        <span style={{ display: 'block', fontWeight: 900, letterSpacing: '.06em', fontSize: 'clamp(40px, 12vw, 54px)', color: '#fff', opacity: 0, animation: struck || reducedMotion ? 'fsStamp .34s cubic-bezier(.2,1.4,.4,1) .12s forwards' : 'none' }}>FORGED,</span>
        <span style={{ display: 'block', fontWeight: 900, letterSpacing: '.06em', fontSize: 'clamp(32px, 9.6vw, 43px)', background: 'linear-gradient(135deg,#EAB308,#F97316)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', filter: 'drop-shadow(0 0 26px rgba(249,115,22,.45))', opacity: 0, animation: struck || reducedMotion ? 'fsStamp .34s cubic-bezier(.2,1.4,.4,1) .34s forwards' : 'none' }}>NOT FINISHED.</span>
        <span style={{ display: 'block', marginTop: 14, fontSize: 13, fontWeight: 800, letterSpacing: '.32em', color: '#8E877A', opacity: 0, animation: struck || reducedMotion ? 'fsFadeup .5s ease-out .85s forwards' : 'none' }}>{String(subline || 'RUN COMPLETE').toUpperCase()}</span>
      </div>
    </div>
  )
}
