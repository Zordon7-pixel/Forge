import { Link } from 'react-router-dom'

export default function Terms() {
  return (
    <div className="min-h-screen px-4 py-10" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <div className="mx-auto w-full max-w-3xl rounded-2xl border p-6 md:p-8" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <h1 className="text-3xl font-black">Terms of Service</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
          FORGE Athlete is provided by Madera Technologies LLC (DBA Zordon Technologies).
        </p>
        <p className="mt-4 text-sm" style={{ color: 'var(--text-muted)' }}>
          Last updated: February 28, 2026
        </p>

        <section className="mt-8">
          <h2 className="text-lg font-bold">Beta access</h2>
          <p className="mt-2 text-sm leading-7" style={{ color: 'var(--text-muted)' }}>
            FORGE is currently offered as free beta software. Features may change, and service may be interrupted, updated, or removed at any
            time.
          </p>
        </section>

        <section className="mt-6">
          <h2 className="text-lg font-bold">No warranty</h2>
          <p className="mt-2 text-sm leading-7" style={{ color: 'var(--text-muted)' }}>
            FORGE is provided "as is" and "as available" without warranties of any kind.
          </p>
        </section>

        <section className="mt-6">
          <h2 className="text-lg font-bold">Your data</h2>
          <p className="mt-2 text-sm leading-7" style={{ color: 'var(--text-muted)' }}>
            You retain ownership of the data you submit to FORGE. By using the app, you give us permission to process that data to deliver and
            improve training analytics and platform functionality.
          </p>
        </section>

        <section className="mt-6">
          <h2 className="text-lg font-bold">Acceptable use</h2>
          <p className="mt-2 text-sm leading-7" style={{ color: 'var(--text-muted)' }}>
            You agree not to misuse the platform, interfere with service operations, attempt unauthorized access, or use FORGE for unlawful
            activity.
          </p>
        </section>

        <section className="mt-6">
          <h2 className="text-lg font-bold">Health disclaimer</h2>
          <p className="mt-2 text-sm leading-7" style={{ color: 'var(--text-muted)' }}>
            FORGE is not medical advice — consult a professional before starting any training program.
          </p>
        </section>

        <section className="mt-6">
          <h2 className="text-lg font-bold">Governing law</h2>
          <p className="mt-2 text-sm leading-7" style={{ color: 'var(--text-muted)' }}>
            These terms are governed by the laws of Maryland, USA.
          </p>
        </section>

        <div className="mt-8 border-t pt-4 text-sm" style={{ borderColor: 'var(--border-subtle)' }}>
          <Link to="/" className="hover:underline" style={{ color: 'var(--accent)' }}>
            Back to FORGE
          </Link>
        </div>
      </div>
    </div>
  )
}
