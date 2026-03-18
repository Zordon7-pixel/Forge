import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import api from '../lib/api'

const ProContext = createContext({
  isPro: false,
  loading: true,
  refreshPro: async () => false,
})

export function ProProvider({ children }) {
  const [isPro, setIsPro] = useState(false)
  const [loading, setLoading] = useState(true)

  const refreshPro = useCallback(async () => {
    try {
      const res = await api.get('/stripe/status').catch(() => api.get('/payments/status'))
      const status = String(res?.data?.subscription_status || '').toLowerCase()
      const hasProFlag = Number(res?.data?.is_pro) === 1
      const pro = status === 'pro' || status === 'active' || status === 'trialing' || hasProFlag
      setIsPro(pro)
      return pro
    } catch {
      setIsPro(false)
      return false
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshPro()
  }, [refreshPro])

  return (
    <ProContext.Provider value={{ isPro, loading, refreshPro }}>
      {children}
    </ProContext.Provider>
  )
}

export function useProContext() {
  return useContext(ProContext)
}
