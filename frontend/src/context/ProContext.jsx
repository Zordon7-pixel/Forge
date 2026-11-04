import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import api from '../lib/api'
import { isLoggedIn } from '../lib/auth'
import { getAuthSession, isAuthSessionCurrent, subscribeAuthSession } from '../lib/tokenStore'

const FREE = { accessSession: null, isPro: false, subscriptionStatus: '', trialEndsAt: null, accessSource: 'free', paidTier: null }
const ProContext = createContext({ ...FREE, loading: true, error: '', refreshPro: async () => false })

export function ProProvider({ children }) {
  const [state, setState] = useState({ ...FREE, loading: true, error: '' })
  const mounted = useRef(false)
  const active = useRef(null)

  const refreshPro = useCallback(() => {
    const session = getAuthSession()
    if (active.current && isAuthSessionCurrent(active.current.session)) return active.current.promise
    active.current?.controller.abort()
    active.current = null
    if (!isLoggedIn()) {
      if (mounted.current) setState({ ...FREE, loading: false, error: '' })
      return Promise.resolve(false)
    }
    const operation = { session, controller: new AbortController(), promise: null }
    active.current = operation
    if (mounted.current) setState({ ...FREE, loading: true, error: '' })
    const current = () => mounted.current && active.current === operation && isAuthSessionCurrent(session)
    operation.promise = (async () => {
      try {
        const res = await api.get('/auth/me', { forgeAuthSession: session, signal: operation.controller.signal })
        if (!current()) return false
        const user = res?.data?.user
        if (typeof user?.entitlement?.effectivePremiumAccess !== 'boolean') throw new Error('Missing entitlement')
        const entitlement = user.entitlement
        const pro = entitlement.effectivePremiumAccess === true
        setState({ accessSession: session, isPro: pro, loading: false, error: '',
          subscriptionStatus: String(user.subscription_status || '').toLowerCase(),
          trialEndsAt: user.subscription_ends_at || null,
          accessSource: entitlement.accessSource || 'free', paidTier: entitlement.paidTier || null })
        return pro
      } catch {
        if (current()) setState({ ...FREE, loading: false, error: 'Could not verify Pro access. Retry the access check.' })
        return false
      } finally {
        if (active.current === operation) active.current = null
      }
    })()
    return operation.promise
  }, [])

  useEffect(() => {
    mounted.current = true
    void refreshPro()
    const unsubscribe = subscribeAuthSession(() => { void refreshPro() })
    const visible = () => { if (document.visibilityState === 'visible') void refreshPro() }
    document.addEventListener('visibilitychange', visible)
    const handles = []
    let disposed = false
    const failure = (error) => console.warn('[ProProvider] resume listener failed:', error?.message)
    const remove = (handle) => {
      try { Promise.resolve(handle?.remove?.()).catch(failure) } catch (error) { failure(error) }
    }
    if (Capacitor.isNativePlatform()) {
      for (const [event, handler] of [
        ['resume', () => { if (!disposed) void refreshPro() }],
        ['appStateChange', ({ isActive }) => { if (isActive && !disposed) void refreshPro() }],
      ]) {
        try {
          Promise.resolve(App.addListener(event, handler)).then((handle) => {
            if (disposed) remove(handle)
            else handles.push(handle)
          }).catch(failure)
        } catch (error) { failure(error) }
      }
    }
    return () => {
      disposed = true
      mounted.current = false
      unsubscribe()
      document.removeEventListener('visibilitychange', visible)
      handles.forEach(remove)
      active.current?.controller.abort()
      active.current = null
    }
  }, [refreshPro])

  return <ProContext.Provider value={{ ...state, refreshPro }}>{children}</ProContext.Provider>
}

export function useProContext() { return useContext(ProContext) }
