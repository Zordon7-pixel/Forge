import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Check, X } from 'lucide-react'
import { useProContext } from '../context/ProContext'
import api from '../lib/api'
import { entitlementPresentation } from '../lib/entitlementPresentation'
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
  const { isPro, loading, subscriptionStatus, trialEndsAt, accessSource, paidTier, refreshPro } = useProContext()
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
  const accessCopy = entitlementPresentation({ accessSource, paidTier })
  const daysLeft = accessSource === 'subscription' && subscriptionStatus === 'trialing'
    ? trialDaysLeft(trialEndsAt)
    : null

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
      <div className="flex items-center justify-center" style={{ minHeight: 'calc(100vh - 120px)', background: 'var(--bg-base)' }}>
        <p className="t-micro">Loading subscription status...</p>
      </div>
    )
  }

  if (isPro) {
    return (
      <div className="flex items-center justify-center px-4" style={{ minHeight: 'calc(100vh - 120px)', background: 'var(--bg-base)' }}>
        <div
          className="card-hero w-full p-8 text-center"
          style={{ maxWidth: 420 }}
        >
          <p className="t-micro" style={{ color: 'var(--accent)' }}>Forged Hybrid Access</p>
          <h1 className="t-title mt-3" style={{ color: 'var(--text-primary)' }}>{accessCopy.title}</h1>
          {redeemSuccess && redeemMessage && <p className="mt-2 text-sm" style={{ color: 'var(--success)' }}>{redeemMessage}</p>}
          {daysLeft !== null && (
            <p className="mt-3 inline-flex rounded-full px-3 py-1 text-xs font-bold" style={{ background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--border-subtle)' }}>
              {daysLeft} {daysLeft === 1 ? 'day' : 'days'} left in trial
            </p>
          )}
          <p className="mt-2" style={{ color: 'var(--text-muted)' }}>{accessCopy.detail}</p>
          <button
            onClick={() => navigate(-1)}
            className="pressable mt-6 min-h-12 rounded-lg px-5 py-3 text-sm font-bold"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer' }}
          >
            Back
          </button>
          <p className="t-micro mt-8">Forged, not finished.</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: 'calc(100vh - 120px)', background: 'var(--bg-base)' }}>
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:py-12">
        <header className="max-w-2xl">
          <p className="t-micro" style={{ color: 'var(--accent)' }}>Forged Hybrid Membership</p>
          <h1 className="t-title mt-3" style={{ color: 'var(--text-primary)' }}>Train with the full signal.</h1>
          <p className="t-body mt-3" style={{ color: 'var(--text-muted)' }}>Free tier supports basic workout logging. Pro unlocks Apple Health sync and premium insights.</p>
        </header>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          <section className="card p-5 sm:p-6">
            <p className="t-micro">Free</p>
            <p className="stat-num mt-3 text-4xl" style={{ color: 'var(--text-primary)' }}>$0</p>
            <p className="t-micro mt-6">Core tools</p>
            <div className="mt-3 space-y-3">
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

          <section className="card-hero p-5 sm:p-6">
            <p className="t-micro" style={{ color: 'var(--accent)' }}>Pro</p>
            <p className="num-ember mt-3 text-4xl leading-none">{plans.find((plan) => plan.id === selectedPlan)?.price}</p>
            <p className="t-micro mt-2">{selectedPlanLabel} access</p>
            <p className="t-micro mt-6">Full coaching signal</p>
            <div className="mt-3 space-y-3">
              {proFeatures.map((feature) => (
                <div key={feature} className="flex items-center gap-2">
                  <Check size={16} color="var(--accent)" />
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{feature}</p>
                </div>
              ))}
            </div>
          </section>
        </div>

        <section className="mt-7">
          <p className="t-micro mb-3">Choose plan</p>
          <div className="flex flex-wrap gap-2">
            {plans.map((plan) => (
              <button
                key={plan.id}
                onClick={() => setSelectedPlan(plan.id)}
                className="pressable min-h-12 rounded-lg px-4 py-2 text-sm font-semibold"
                style={selectedPlan === plan.id
                  ? { background: 'var(--accent)', color: 'var(--on-accent)', border: '1px solid var(--accent)' }
                  : { background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}
              >
                {plan.label} ({plan.price})
              </button>
            ))}
          </div>
        </section>

        <div className="mt-7 flex flex-col items-stretch gap-3">
          <button
            onClick={startCheckout}
            disabled={submitting}
            className="pressable min-h-12 rounded-lg px-6 py-3 text-sm font-black disabled:opacity-60"
            style={{ background: 'var(--ember-grad)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer' }}
          >
            {submitting ? 'Starting...' : `Continue with ${selectedPlanLabel}`}
          </button>
          {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
          <form onSubmit={redeemCompCode} className="card mt-3 flex w-full flex-col gap-2 p-4 sm:flex-row">
            <input
              className="min-h-12 rounded-lg px-3 py-3 text-sm"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', flex: 1 }}
              placeholder="Comp code"
              value={compCode}
              onChange={(e) => setCompCode(e.target.value)}
            />
            <button
              type="submit"
              disabled={redeeming || !compCode.trim()}
              className="pressable min-h-12 rounded-lg px-5 py-3 text-sm font-bold disabled:opacity-60"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', cursor: 'pointer' }}
            >
              {redeeming ? 'Redeeming...' : 'Redeem'}
            </button>
          </form>
          {redeemMessage && <p className="text-sm" style={{ color: redeemSuccess ? 'var(--success)' : 'var(--danger)' }}>{redeemMessage}</p>}
          <button
            onClick={() => navigate(-1)}
            className="pressable min-h-12 self-center px-4 text-sm underline"
            style={{ color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
          >
            Maybe later
          </button>
        </div>
        <p className="t-micro mt-10 text-center">Forged, not finished.</p>
      </div>
    </div>
  )
}
