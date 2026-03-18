import { Capacitor } from '@capacitor/core'
import api from '../lib/api'

const STRIPE_PUBLISHABLE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY

function isNative() {
  return typeof Capacitor !== 'undefined' && typeof Capacitor.isNativePlatform === 'function' && Capacitor.isNativePlatform()
}

async function loadNativeStripeSdk() {
  try {
    const mod = await import('@stripe/stripe-react-native')
    return mod
  } catch {
    return null
  }
}

export async function startStripeSubscription(plan = 'monthly') {
  const native = isNative()
  const { data } = await api.post('/stripe/create-subscription', {
    plan,
    usePaymentSheet: native,
  })

  if (!native) {
    if (data?.checkoutUrl && typeof window !== 'undefined') {
      window.location.href = data.checkoutUrl
      return { redirected: true }
    }
    throw new Error('Checkout URL missing from subscription response.')
  }

  const sdk = await loadNativeStripeSdk()
  if (!sdk) {
    throw new Error('Stripe React Native SDK is not available in this build.')
  }

  if (!STRIPE_PUBLISHABLE_KEY) {
    throw new Error('VITE_STRIPE_PUBLISHABLE_KEY is not configured.')
  }

  const paymentSheet = data?.paymentSheet
  if (!paymentSheet?.paymentIntentClientSecret || !paymentSheet?.customerEphemeralKeySecret || !paymentSheet?.customerId) {
    throw new Error('Invalid payment sheet payload from backend.')
  }

  await sdk.initStripe({
    publishableKey: STRIPE_PUBLISHABLE_KEY,
    merchantIdentifier: 'merchant.forge.app',
  })

  const initResult = await sdk.initPaymentSheet({
    merchantDisplayName: 'FORGE',
    customerId: paymentSheet.customerId,
    customerEphemeralKeySecret: paymentSheet.customerEphemeralKeySecret,
    paymentIntentClientSecret: paymentSheet.paymentIntentClientSecret,
    allowsDelayedPaymentMethods: true,
  })

  if (initResult?.error) {
    throw new Error(initResult.error.message || 'Unable to initialize Stripe payment sheet.')
  }

  const presentResult = await sdk.presentPaymentSheet()
  if (presentResult?.error) {
    throw new Error(presentResult.error.message || 'Payment was cancelled.')
  }

  return { ok: true, subscriptionId: paymentSheet.subscriptionId }
}
