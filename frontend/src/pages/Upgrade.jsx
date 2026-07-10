import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, X } from 'lucide-react'
import { useProContext } from '../context/ProContext'
import api from '../lib/api'
import { startStripeSubscription } from '../services/StripeService'

const freeFeatures = [
  'Basic workout logging',
  'Manual run and lift entries',
  'Standard training timeline',
]

const proFeatures = [
  'Apple Health sync',
  'PR Wall',
  'Weekly Recap',
  'Advanced analytics',
]

const plans = [
  { id: 'monthly', label: 'Monthly', price: '$9.99' },
  { id: 'annual', label: 'Annual', price: '$99.99' },
]

function trialDaysLeft(date) {
  if (!date) return null
  const time = new Date(date).getTime()
  if (Number.isNaN(time)) return null
  return Math.max(0, Math.ceil((time - Date.now()) / 86400000))
}

export default function Upgrade() {
  const navigate = useNavigate()
  const { isPro, loading, subscriptionStatus, trialEndsAt, refreshPro } = useProContext()
  const [selectedPlan, setSelectedPlan] = useState('monthly')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [compCode, setCompCode] = useState('')
  const [redeeming, setRedeeming] = useState(false)
  const [redeemMessage, setRedeemMessage] = useState('')
  const [redeemSuccess, setRedeemSuccess] = useState(false)

  const selectedPlanLabel = useMemo(
    () => plans.find((plan) => plan.id === selectedPlan)?.label || 'Monthly',
    [selectedPlan]
  )
  const daysLeft = subscriptionStatus === 'trialing' ? trialDaysLeft(trialEndsAt) : null

  const startCheckout = async () => {
    setSubmitting(true)
    setError('')
    try {
      await startStripeSubscription(selectedPlan)
      await refreshPro()
    } catch (err) {
      setError(err?.message || 'Unable to start subscription flow right now.')
    } finally {
      setSubmitting(false)
    }
  }

  const redeemCompCode = async (e) => {
    e.preventDefault()
    setRedeeming(true)
    setRedeemMessage('')
    setRedeemSuccess(false)

    try {
      await api.post('/comp/redeem', { code: compCode.trim() })
      await refreshPro()
      setRedeemSuccess(true)
      setRedeemMessage('Code redeemed. Pro is unlocked.')
      window.setTimeout(() => navigate(-1), 900)
    } catch (err) {
      setRedeemMessage(err?.response?.data?.error || err?.response?.data?.message || 'Unable to redeem this code.')
    } finally {
      setRedeeming(false)
    }
  }

  if (loading) {
    return (
      <div style={{ minHeight: 'calc(100vh - 120px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-muted)' }}>Loading subscription status...</p>
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
          <h1 className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>You are on FORGE Pro</h1>
          {redeemSuccess && redeemMessage && <p className="mt-2 text-sm" style={{ color: 'var(--success)' }}>{redeemMessage}</p>}
          {daysLeft !== null && (
            <p className="mt-3 inline-flex rounded-full px-3 py-1 text-xs font-bold" style={{ background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--border-subtle)' }}>
              {daysLeft} {daysLeft === 1 ? 'day' : 'days'} left in trial
            </p>
          )}
          <p className="mt-2" style={{ color: 'var(--text-muted)' }}>Apple Health sync and premium insights are unlocked.</p>
          <button
            onClick={() => navigate(-1)}
            className="mt-6 rounded-lg px-5 py-3 text-sm font-bold"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer' }}
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
        <h1 className="text-3xl font-black" style={{ color: 'var(--text-primary)' }}>FORGE Subscription</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>Free tier supports basic workout logging. Pro unlocks Apple Health sync and premium insights.</p>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          <section className="rounded-2xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Free</p>
            <p className="mt-2 text-2xl font-black" style={{ color: 'var(--text-primary)' }}>$0</p>
            <div className="mt-4 space-y-3">
              {freeFeatures.map((feature) => (
                <div key={feature} className="flex items-center gap-2">
                  <Check size={16} color="var(--success)" />
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{feature}</p>
                </div>
              ))}
              {proFeatures.map((feature) => (
                <div key={feature} className="flex items-center gap-2 opacity-80">
                  <X size={16} color="var(--text-muted)" />
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{feature}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--accent)' }}>Pro</p>
            <p className="mt-2 text-2xl font-black" style={{ color: 'var(--text-primary)' }}>{plans.find((plan) => plan.id === selectedPlan)?.price}</p>
            <div className="mt-4 space-y-3">
              {proFeatures.map((feature) => (
                <div key={feature} className="flex items-center gap-2">
                  <Check size={16} color="var(--accent)" />
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{feature}</p>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="mt-6">
          <p className="mb-2 text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Choose plan</p>
          <div className="flex flex-wrap gap-2">
            {plans.map((plan) => (
              <button
                key={plan.id}
                onClick={() => setSelectedPlan(plan.id)}
                className="rounded-full px-4 py-2 text-sm font-semibold"
                style={selectedPlan === plan.id
                  ? { background: 'var(--accent)', color: 'var(--on-accent)', border: '1px solid var(--accent)' }
                  : { background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}
              >
                {plan.label} ({plan.price})
              </button>
            ))}
          </div>
        </div>

        <div className="mt-7 flex flex-col items-start gap-3">
          <button
            onClick={startCheckout}
            disabled={submitting}
            className="rounded-lg px-6 py-3 text-sm font-bold disabled:opacity-60"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer' }}
          >
            {submitting ? 'Starting...' : `Continue with ${selectedPlanLabel}`}
          </button>
          {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
          <form onSubmit={redeemCompCode} className="mt-3 flex w-full max-w-md flex-col gap-2 sm:flex-row">
            <input
              className="rounded-lg px-3 py-3 text-sm"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', flex: 1 }}
              placeholder="Comp code"
              value={compCode}
              onChange={(e) => setCompCode(e.target.value)}
            />
            <button
              type="submit"
              disabled={redeeming || !compCode.trim()}
              className="rounded-lg px-5 py-3 text-sm font-bold disabled:opacity-60"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', cursor: 'pointer' }}
            >
              {redeeming ? 'Redeeming...' : 'Redeem'}
            </button>
          </form>
          {redeemMessage && <p className="text-sm" style={{ color: redeemSuccess ? 'var(--success)' : 'var(--danger)' }}>{redeemMessage}</p>}
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
