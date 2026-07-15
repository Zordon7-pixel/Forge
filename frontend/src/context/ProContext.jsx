import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import api from '../lib/api'
import { isLoggedIn } from '../lib/auth'

const ProContext = createContext({
  isPro: false,
  loading: true,
  subscriptionStatus: '',
  trialEndsAt: null,
  refreshPro: async () => false,
})

export function ProProvider({ children }) {
  const [isPro, setIsPro] = useState(false)
  const [loading, setLoading] = useState(true)
  const [subscriptionStatus, setSubscriptionStatus] = useState('')
  const [trialEndsAt, setTrialEndsAt] = useState(null)

  const refreshPro = useCallback(async () => {
    if (!isLoggedIn()) {
      setIsPro(false)
      setSubscriptionStatus('')
      setTrialEndsAt(null)
      setLoading(false)
      return false
    }

    try {
      const res = await api.get('/stripe/status').catch(() => api.get('/payments/status'))
      const status = String(res?.data?.subscription_status || '').toLowerCase()
      const hasProFlag = Number(res?.data?.is_pro) === 1
      const pro = Boolean(res?.data?.beta_access) || status === 'pro' || status === 'active' || status === 'trialing' || hasProFlag
      setIsPro(pro)
      setSubscriptionStatus(status)
      setTrialEndsAt(res?.data?.subscription_ends_at || null)
      return pro
    } catch {
      setIsPro(false)
      setSubscriptionStatus('')
      setTrialEndsAt(null)
      return false
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshPro()
  }, [refreshPro])

  return (
    <ProContext.Provider value={{ isPro, loading, subscriptionStatus, trialEndsAt, refreshPro }}>
      {children}
    </ProContext.Provider>
  )
}

export function useProContext() {
  return useContext(ProContext)
}
