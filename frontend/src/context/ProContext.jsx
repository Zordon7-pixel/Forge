import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import api from '../lib/api'
import { isLoggedIn } from '../lib/auth'

const ProContext = createContext({
  isPro: false,
  loading: true,
  subscriptionStatus: '',
  trialEndsAt: null,
  accessSource: 'free',
  paidTier: null,
  refreshPro: async () => false,
})

export function ProProvider({ children }) {
  const [isPro, setIsPro] = useState(false)
  const [loading, setLoading] = useState(true)
  const [subscriptionStatus, setSubscriptionStatus] = useState('')
  const [trialEndsAt, setTrialEndsAt] = useState(null)
  const [accessSource, setAccessSource] = useState('free')
  const [paidTier, setPaidTier] = useState(null)

  const refreshPro = useCallback(async () => {
    if (!isLoggedIn()) {
      setIsPro(false)
      setSubscriptionStatus('')
      setTrialEndsAt(null)
      setAccessSource('free')
      setPaidTier(null)
      setLoading(false)
      return false
    }

    try {
      const res = await api.get('/auth/me')
      const user = res?.data?.user || {}
      const entitlement = user.entitlement || {}
      const status = String(user.subscription_status || '').toLowerCase()
      const pro = entitlement.effectivePremiumAccess === true
      setIsPro(pro)
      setSubscriptionStatus(status)
      setTrialEndsAt(user.subscription_ends_at || null)
      setAccessSource(entitlement.accessSource || 'free')
      setPaidTier(entitlement.paidTier || null)
      return pro
    } catch {
      setIsPro(false)
      setSubscriptionStatus('')
      setTrialEndsAt(null)
      setAccessSource('free')
      setPaidTier(null)
      return false
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshPro()
  }, [refreshPro])

  return (
    <ProContext.Provider value={{ isPro, loading, subscriptionStatus, trialEndsAt, accessSource, paidTier, refreshPro }}>
      {children}
    </ProContext.Provider>
  )
}

export function useProContext() {
  return useContext(ProContext)
}
