import { Link } from 'react-router-dom'

export default function Privacy() {
  return (
    <div className="min-h-screen px-4 py-10" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <div className="mx-auto w-full max-w-3xl rounded-2xl border p-6 md:p-8" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <h1 className="text-3xl font-black">Privacy Policy</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
          Madera Technologies LLC | Forged Hybrid
        </p>
        <p className="mt-4 text-sm" style={{ color: 'var(--text-muted)' }}>
          Last updated: July 13, 2026
        </p>

        <section className="mt-8">
          <h2 className="text-lg font-bold">What data we collect</h2>
          <p className="mt-2 text-sm leading-7" style={{ color: 'var(--text-muted)' }}>
            We collect the information needed to run Forged Hybrid: your account email, workout and training logs, and connected device
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
          <h2 className="text-lg font-bold">Feedback and support data</h2>
          <p className="mt-2 text-sm leading-7" style={{ color: 'var(--text-muted)' }}>
            When you send in-app feedback, we collect the message you submit, the current app screen, basic account context, and severity or
            category selections. We use that information only to investigate bugs, answer support issues, and improve FORGE. Do not include
            passwords, payment details, emergency medical information, or unrelated sensitive data in feedback.
          </p>
        </section>

        <section className="mt-6">
          <h2 className="text-lg font-bold">Connected services and health data</h2>
          <p className="mt-2 text-sm leading-7" style={{ color: 'var(--text-muted)' }}>
            With your permission, Forged Hybrid reads training-relevant health and workout data from Apple Health (iOS) and Android Health Connect —
            including workouts, activity, sleep stages, heart rate, HRV, resting heart rate, cardio-fitness estimates, and running dynamics — to generate and adapt your training plans. We do not request unrelated medical, reproductive, ECG, blood-pressure, or AFib data for this purpose. When you
            choose an available connection to a third-party training platform or watch, Forged Hybrid may send the generated workouts,
            planned sessions, or routes you select so they appear on that account or device. Provider availability varies, and planned
            connections are labeled Coming soon until approved and operational. Each live connection is authorized by you and can be
            disconnected at any time. We exchange only the data needed for the connected fitness feature. We do not sell health data or use it for advertising.
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
            Back to Forged Hybrid
          </Link>
        </div>
      </div>
    </div>
  )
}
