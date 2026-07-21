import { Link } from 'react-router-dom'
import { Flame, Watch, Brain } from 'lucide-react'

// Tempered Steel & Ember marketing surface. Hex required: public page renders
// before the app theme mounts, and the design commits to one dark visual world.
const GRAD = 'linear-gradient(135deg,#EAB308,#F97316)'
const HEAT = [
  { color: '#5E6C7B', flex: 0.9 },
  { color: '#EAB308', flex: 1.6 },
  { color: '#F97316', flex: 1.3 },
  { color: '#E5484D', flex: 1.1 },
  { color: '#FFF6DC', flex: 0.4, glow: true },
]

function HeatLine() {
  return (
    <div className="flex" style={{ height: 7 }}>
      {HEAT.map((zone) => (
        <i key={zone.color} style={{ flex: zone.flex, background: zone.color, boxShadow: zone.glow ? '0 0 18px rgba(255,246,220,.8)' : 'none' }} />
      ))}
    </div>
  )
}

export default function Landing() {
  return (
    <div className="min-h-screen" style={{ background: '#080604', color: '#EDE6D6' }}>
      <header className="relative flex min-h-[88vh] flex-col justify-center overflow-hidden px-6 py-20 md:px-16">
        <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(700px 420px at 82% 110%, rgba(249,115,22,0.20), transparent 65%), radial-gradient(520px 300px at 12% -10%, rgba(234,179,8,0.07), transparent 60%)' }} />
        <div className="relative flex items-center gap-3 text-[13px] font-black" style={{ color: '#EAB308', letterSpacing: '.3em' }}>
          <img src="/icon-192.png" alt="" className="h-7 w-7 rounded-md object-cover" />
          FORGED HYBRID
        </div>
        <h1 className="relative mt-6 max-w-[12ch] font-black" style={{ fontSize: 'clamp(44px,7.2vw,96px)', lineHeight: 0.98, color: '#F5EFE2' }}>
          The coach for runners{' '}
          <span style={{ background: GRAD, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>who lift.</span>
        </h1>
        <p className="relative mt-6 max-w-[52ch] text-lg leading-relaxed" style={{ color: '#8E877A' }}>
          Miles and iron fight each other — unless something manages the interference. Forged Hybrid reads your runs, your lifts, and your recovery, then forges one plan where both make each other stronger.
        </p>
        <div className="relative mt-10 flex flex-wrap gap-3">
          <Link to="/register" className="rounded-2xl px-8 py-4 text-base font-black" style={{ background: GRAD, color: '#141008', boxShadow: '0 8px 40px rgba(249,115,22,.32)' }}>Start Forging</Link>
          <Link to="/login" className="rounded-2xl border px-8 py-4 text-base font-bold" style={{ borderColor: 'rgba(255,246,220,.22)', color: '#EDE6D6' }}>Sign In</Link>
        </div>
      </header>

      <HeatLine />

      <section className="grid grid-cols-2 md:grid-cols-4" style={{ borderTop: '1px solid rgba(255,246,220,.07)', borderBottom: '1px solid rgba(255,246,220,.07)' }}>
        {[
          ['6.24', 'mi', 'TRACKED LIVE'],
          ['315', 'lb', 'PR LOGGED'],
          ['Z4', '', 'EFFORT KNOWN'],
          ['1', '', 'PLAN. YOURS.'],
        ].map(([value, unit, label], index) => (
          <div key={label} className={`px-3 py-8 text-center ${index % 2 === 0 ? 'border-r' : ''} ${index < 3 ? 'md:border-r' : 'md:border-r-0'} ${index < 2 ? 'border-b md:border-b-0' : ''}`} style={{ borderColor: 'rgba(255,246,220,.07)' }}>
            <div className="font-black" style={{ fontSize: 'clamp(22px,4vw,40px)', color: '#fff', fontVariantNumeric: 'tabular-nums' }}>
              {value}<em className="not-italic" style={{ color: '#EAB308', fontSize: '0.5em' }}>{unit}</em>
            </div>
            <div className="mt-1 text-[10px] font-extrabold md:text-[11px]" style={{ letterSpacing: '.24em', color: '#5B5648' }}>{label}</div>
          </div>
        ))}
      </section>

      <section className="grid gap-4 px-6 py-20 md:grid-cols-3 md:px-16">
        {[
          { icon: Flame, title: 'Plans that adapt daily', text: "Sleep short? HR elevated? Yesterday's squats still in your legs? Today's session already knows — effort is re-forged before you tie your shoes." },
          { icon: Watch, title: 'Your watch, wired in', text: 'Apple Watch and Health sync out of the box; Garmin, COROS and friends through file import. Background GPS keeps recording with your screen off.' },
          { icon: Brain, title: 'A coach that explains itself', text: 'Every recommendation says why — interference, load, recovery. No black box, no generic athlete dashboard. Guidance you can argue with.' },
        ].map((feature) => (
          <div key={feature.title} className="group relative overflow-hidden rounded-3xl border p-8" style={{ background: '#16130D', borderColor: 'rgba(255,246,220,.08)' }}>
            <span className="absolute bottom-0 left-0 top-0 w-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100" style={{ background: GRAD }} />
            <div className="grid h-12 w-12 place-items-center rounded-xl" style={{ background: 'rgba(234,179,8,.1)' }}>
              <feature.icon size={22} style={{ color: '#EAB308' }} />
            </div>
            <h3 className="mt-5 text-xl font-black" style={{ color: '#F5EFE2' }}>{feature.title}</h3>
            <p className="mt-3 text-[15px] leading-relaxed" style={{ color: '#8E877A' }}>{feature.text}</p>
          </div>
        ))}
      </section>

      <section className="relative overflow-hidden px-6 py-24 text-center" style={{ borderTop: '1px solid rgba(255,246,220,.07)' }}>
        <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(640px 340px at 50% 130%, rgba(249,115,22,.24), transparent 70%)' }} />
        <img src="/icon-192.png" alt="" className="relative mx-auto h-16 w-16 rounded-2xl object-cover" />
        <h2 className="relative mt-6 font-black" style={{ fontSize: 'clamp(36px,5.6vw,72px)', letterSpacing: '.04em' }}>
          <span style={{ color: '#fff' }}>FORGED, </span>
          <span style={{ background: GRAD, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>NOT FINISHED.</span>
        </h2>
        <p className="relative mt-4 text-base" style={{ color: '#8E877A', letterSpacing: '.06em' }}>Every run is one more strike of the hammer.</p>
      </section>

      <section className="px-6 py-8 md:px-16" style={{ borderTop: '1px solid rgba(255,246,220,.07)' }}>
        <p className="text-sm" style={{ color: '#8E877A' }}>
          Built by the same team behind{' '}
          <a href="https://revv.run" target="_blank" rel="noreferrer" style={{ color: '#EAB308' }}>REVV</a>
          {' '}and{' '}
          <a href="https://payload.fit" target="_blank" rel="noreferrer" style={{ color: '#EAB308' }}>PAYLOAD</a>.
        </p>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-3 px-6 pb-14 pt-6 text-xs md:px-16" style={{ color: '#5B5648' }}>
        <span>© {new Date().getFullYear()} Forged Hybrid · Madera Technologies LLC</span>
        <div className="flex gap-5">
          <Link to="/login" style={{ color: '#8E877A' }}>Sign In</Link>
          <Link to="/register" style={{ color: '#8E877A' }}>Create Account</Link>
          <Link to="/privacy" style={{ color: '#8E877A' }}>Privacy</Link>
          <Link to="/terms" style={{ color: '#8E877A' }}>Terms</Link>
        </div>
      </footer>
    </div>
  )
}
