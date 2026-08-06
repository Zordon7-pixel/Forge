import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { useLocation, useNavigate } from 'react-router'
import { getAuthenticatedUserId } from '../lib/auth'
import track from '../lib/track'
import { normalizeBuildNumber } from '../services/watchWorkoutAvailability'
import { eligibleReleases, newestEligibleRelease } from '../data/releases'
import {
  acknowledgeRelease,
  loadReleaseState,
  releasePromptSessionKey,
} from '../lib/releaseState'
import WhatsNewSheet from '../components/WhatsNewSheet'

const ReleaseNotesContext = createContext(null)

function sessionHas(key) {
  try { return sessionStorage.getItem(key) === '1' } catch { return false }
}

function markSession(key) {
  try { sessionStorage.setItem(key, '1') } catch (error) {
    console.warn('[ReleaseNotes] session state unavailable:', error?.message || error)
  }
}

async function runtimeInfo() {
  if (!Capacitor?.isNativePlatform?.()) return { platform: 'web', build: null }
  const platform = Capacitor.getPlatform()
  try {
    const info = await CapacitorApp.getInfo()
    return { platform, build: normalizeBuildNumber(info?.build) }
  } catch (error) {
    console.warn('[ReleaseNotes] native build lookup failed:', error?.message || error)
    return { platform, build: null }
  }
}

export function ReleaseNotesProvider({ children, suppressed = false }) {
  const location = useLocation()
  const navigate = useNavigate()
  const userId = getAuthenticatedUserId()
  const [runtime, setRuntime] = useState({ platform: 'web', build: null })
  const [seenSequence, setSeenSequence] = useState(0)
  const [stateReady, setStateReady] = useState(false)
  const [activeRelease, setActiveRelease] = useState(null)

  useEffect(() => {
    let current = true
    runtimeInfo().then((value) => { if (current) setRuntime(value) })
    return () => { current = false }
  }, [])

  useEffect(() => {
    if (!userId) {
      setSeenSequence(0)
      setStateReady(true)
      return undefined
    }
    let current = true
    setStateReady(false)
    loadReleaseState(userId).then((state) => {
      if (!current) return
      setSeenSequence(state.seenSequence)
      setStateReady(true)
    })
    return () => { current = false }
  }, [userId])

  const releases = useMemo(() => eligibleReleases(runtime), [runtime])
  const latest = useMemo(() => newestEligibleRelease(runtime), [runtime])
  const unread = Boolean(latest && latest.sequence > seenSequence)

  const acknowledge = useCallback(async (sequence, analytics = null) => {
    const next = Number(sequence || 0)
    setSeenSequence((current) => Math.max(current, next))
    setActiveRelease(null)
    if (analytics) track(analytics.event, analytics.props)
    if (userId) await acknowledgeRelease(userId, next)
  }, [userId])

  const snooze = useCallback(() => {
    if (activeRelease && userId) markSession(releasePromptSessionKey(userId, activeRelease.sequence))
    setActiveRelease(null)
  }, [activeRelease, userId])

  useEffect(() => {
    if (!stateReady || !userId || !unread || !latest || suppressed || activeRelease) return undefined
    if (location.pathname === '/whats-new') return undefined
    const promptKey = releasePromptSessionKey(userId, latest.sequence)
    if (sessionHas(promptKey)) return undefined

    let cancelled = false
    let timer = null
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        if (cancelled || document.querySelector('[role="dialog"][aria-modal="true"]')) return
        markSession(promptKey)
        setActiveRelease(latest)
        track('whats_new_shown', { surface: 'sheet', action: 'shown', value: latest.sequence })
      }, 160)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      if (timer) window.clearTimeout(timer)
    }
  }, [activeRelease, latest, location.pathname, stateReady, suppressed, unread, userId])

  useEffect(() => {
    if (suppressed && activeRelease) snooze()
  }, [activeRelease, snooze, suppressed])

  const markAllSeen = useCallback((surface = 'more') => latest
    ? acknowledge(latest.sequence, { event: 'whats_new_opened', props: { surface, action: 'opened', value: latest.sequence } })
    : Promise.resolve(), [acknowledge, latest])

  const value = useMemo(() => ({
    releases,
    latest,
    seenSequence,
    unread,
    acknowledge,
    markAllSeen,
  }), [acknowledge, latest, markAllSeen, releases, seenSequence, unread])

  return (
    <ReleaseNotesContext.Provider value={value}>
      {children}
      <WhatsNewSheet
        release={activeRelease}
        onSnooze={snooze}
        onAcknowledge={() => acknowledge(activeRelease?.sequence, {
          event: 'whats_new_opened',
          props: { surface: 'sheet', action: 'acknowledged', value: activeRelease?.sequence || 0 },
        })}
        onViewAll={() => acknowledge(activeRelease?.sequence).then(() => navigate('/whats-new'))}
        onCta={() => acknowledge(activeRelease?.sequence, {
          event: 'whats_new_cta',
          props: { surface: 'sheet', action: 'cta', value: activeRelease?.sequence || 0 },
        }).then(() => navigate(activeRelease?.cta?.to || '/more'))}
      />
    </ReleaseNotesContext.Provider>
  )
}

export function useReleaseNotes() {
  const context = useContext(ReleaseNotesContext)
  if (!context) throw new Error('useReleaseNotes must be used inside ReleaseNotesProvider')
  return context
}
