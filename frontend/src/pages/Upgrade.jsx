import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, X } from 'lucide-react'
import api from '../lib/api'
import { useProContext } from '../context/ProContext'

const freeFeatures = [
  'Unlimited workout logging',
  'Basic progress charts',
  '1 AI plan/month',
]

const proFeatures = [
  'Unlimited AI training plans',
  'Full Challenges access',
  'Weekly Recap and insights',
  'Priority support',
  'Early access to new features',
]

export default function Upgrade() {
  const navigate = useNavigate()
  const { isPro, loading } = useProContext()
  const [submitting, setSubmitting] = useState(false)

  const startCheckout = async () => {
    setSubmitting(true)
    try {
      const res = await api.post('/payments/create-subscription-session')
      const url = res?.data?.url
      if (url) {
        window.location.href = url
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div style={{ minHeight: 'calc(100vh - 120px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-muted)' }}>Loading Pro status...</p>
      </div>
    )
  }

  if (isPro) {
    return (
      <div style={{ minHeight: 'calc(100vh - 120px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div
          className="rounded-2xl p-8"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', textAlign: 'center', maxWidth: 420, width: '100%' }}
        >
          <h1 className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>You are already Pro</h1>
          <p className="mt-2" style={{ color: 'var(--text-muted)' }}>All premium features are unlocked on your account.</p>
          <button
            onClick={() => navigate(-1)}
            className="mt-6 rounded-lg px-5 py-3 text-sm font-bold"
            style={{ background: '#EAB308', color: '#000', border: 'none', cursor: 'pointer' }}
          >
            Back
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: 'calc(100vh - 120px)', background: 'var(--bg-base)' }}>
      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        <h1 className="text-3xl font-black" style={{ color: 'var(--text-primary)' }}>Upgrade to FORGE Pro</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>Unlock advanced tools built for serious progress.</p>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          <section className="rounded-2xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Free</p>
            <p className="mt-2 text-2xl font-black" style={{ color: 'var(--text-primary)' }}>$0</p>
            <div className="mt-4 space-y-3">
              {freeFeatures.map((feature) => (
                <div key={feature} className="flex items-center gap-2">
                  <Check size={16} color="#22c55e" />
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{feature}</p>
                </div>
              ))}
              {proFeatures.slice(0, 2).map((feature) => (
                <div key={feature} className="flex items-center gap-2 opacity-80">
                  <X size={16} color="var(--text-muted)" />
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{feature}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid rgba(234,179,8,0.45)' }}>
            <p className="text-xs font-bold uppercase tracking-wider" style={{ color: '#EAB308' }}>Pro</p>
            <p className="mt-2 text-2xl font-black" style={{ color: 'var(--text-primary)' }}>$4.99/mo</p>
            <div className="mt-4 space-y-3">
              {proFeatures.map((feature) => (
                <div key={feature} className="flex items-center gap-2">
                  <Check size={16} color="#EAB308" />
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{feature}</p>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="mt-7 flex flex-col items-start gap-3">
          <button
            onClick={startCheckout}
            disabled={submitting}
            className="rounded-lg px-6 py-3 text-sm font-bold disabled:opacity-60"
            style={{ background: '#EAB308', color: '#000', border: 'none', cursor: 'pointer' }}
          >
            {submitting ? 'Redirecting...' : 'Upgrade to Pro'}
          </button>
          <button
            onClick={() => navigate(-1)}
            className="text-sm underline"
            style={{ color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
          >
            Maybe later
          </button>
        </div>
      </div>
    </div>
  )
}
