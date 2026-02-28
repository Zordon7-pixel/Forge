import { Link } from 'react-router-dom'

export default function Privacy() {
  return (
    <div className="min-h-screen px-4 py-10" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <div className="mx-auto w-full max-w-3xl rounded-2xl border p-6 md:p-8" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <h1 className="text-3xl font-black">Privacy Policy</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
          Madera Technologies LLC (DBA Zordon Technologies) | FORGE Athlete
        </p>
        <p className="mt-4 text-sm" style={{ color: 'var(--text-muted)' }}>
          Last updated: February 28, 2026
        </p>

        <section className="mt-8">
          <h2 className="text-lg font-bold">What data we collect</h2>
          <p className="mt-2 text-sm leading-7" style={{ color: 'var(--text-muted)' }}>
            We collect the information needed to run FORGE Athlete: your account email, workout and training logs, and connected device
            metrics like steps and heart rate.
          </p>
        </section>

        <section className="mt-6">
          <h2 className="text-lg font-bold">How we use your data</h2>
          <p className="mt-2 text-sm leading-7" style={{ color: 'var(--text-muted)' }}>
            Your data is used only to power your training experience, including analytics, coaching insights, progress tracking, and product
            reliability. We do not sell your personal data.
          </p>
        </section>

        <section className="mt-6">
          <h2 className="text-lg font-bold">Data deletion</h2>
          <p className="mt-2 text-sm leading-7" style={{ color: 'var(--text-muted)' }}>
            You can request account and data deletion at any time by emailing{' '}
            <a href="mailto:privacy@forgeathlete.app" className="hover:underline" style={{ color: 'var(--accent)' }}>
              privacy@forgeathlete.app
            </a>
            . We will verify the request and process it within a reasonable timeframe.
          </p>
        </section>

        <section className="mt-6">
          <h2 className="text-lg font-bold">GDPR and CCPA basics</h2>
          <p className="mt-2 text-sm leading-7" style={{ color: 'var(--text-muted)' }}>
            Depending on where you live, you may have rights to access, correct, delete, or receive a copy of your data, and to limit certain
            uses. We honor applicable GDPR and CCPA rights requests through the email above.
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
