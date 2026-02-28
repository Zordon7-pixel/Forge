import { Link } from 'react-router-dom'
import { Brain, Watch, Sparkles } from 'lucide-react'

export default function Landing() {
  return (
    <div className="min-h-screen" style={{ background: '#0a0a0a', color: '#f5f5f5' }}>
      <div className="mx-auto max-w-5xl px-6 py-12">
        <section className="py-16 text-center">
          <p className="text-sm tracking-[0.2em] mb-4" style={{ color: '#EAB308' }}>FORGE</p>
          <h1 className="text-4xl md:text-6xl font-black leading-tight">Built to adapt. AI coaching that learns your body.</h1>
          <p className="mt-4 text-base md:text-lg text-neutral-300 max-w-2xl mx-auto">Train smarter with adaptive plans, real performance feedback, and seamless activity sync.</p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link to="/register" className="rounded-xl px-6 py-3 font-bold" style={{ background: '#EAB308', color: '#0a0a0a' }}>Get Started</Link>
            <Link to="/login" className="rounded-xl px-6 py-3 font-semibold border" style={{ borderColor: '#3f3f46', color: '#f5f5f5' }}>Sign In</Link>
          </div>
        </section>

        <section className="grid md:grid-cols-3 gap-4 py-10">
          {[
            { icon: Brain, title: 'Personalized Training', text: 'Plans adapt to your recovery, goals, and consistency each week.' },
            { icon: Watch, title: 'Watch Integration', text: 'Sync from wearables or import activity files when sync is unavailable.' },
            { icon: Sparkles, title: 'AI Coach Feedback', text: 'Get targeted guidance for effort, load management, and race prep.' },
          ].map((f) => (
            <div key={f.title} className="rounded-2xl p-5 border" style={{ borderColor: '#27272a', background: '#111111' }}>
              <f.icon size={20} style={{ color: '#EAB308' }} />
              <h3 className="mt-3 text-lg font-bold">{f.title}</h3>
              <p className="mt-2 text-sm text-neutral-400">{f.text}</p>
            </div>
          ))}
        </section>

        <section className="py-8 border-t" style={{ borderColor: '#27272a' }}>
          <p className="text-sm text-neutral-300">
            Built by the same team behind{' '}
            <a href="https://revv.run" target="_blank" rel="noreferrer" style={{ color: '#EAB308' }}>REVV</a>
            {' '}and{' '}
            <a href="https://payload.fit" target="_blank" rel="noreferrer" style={{ color: '#EAB308' }}>PAYLOAD</a>.
          </p>
        </section>

        <footer className="pt-10 pb-4 text-xs text-neutral-500 flex flex-wrap items-center justify-between gap-2">
          <span>© {new Date().getFullYear()} FORGE</span>
          <div className="flex gap-4">
            <Link to="/login">Sign In</Link>
            <Link to="/register">Create Account</Link>
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
          </div>
        </footer>
      </div>
    </div>
  )
}
