import { useEffect, useRef } from 'react'
import { Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

const HISTORY_MARKER = '__forgedWhatsNew'

export default function WhatsNewSheet({ release, onSnooze, onAcknowledge, onViewAll, onCta }) {
  const { t } = useTranslation()
  const dialogRef = useRef(null)
  const closeInProgress = useRef(false)
  const priorFocus = useRef(null)

  useEffect(() => {
    if (!release) return undefined
    closeInProgress.current = false
    priorFocus.current = document.activeElement
    const marker = `${release.sequence}-${Date.now()}`
    window.history.pushState({ ...window.history.state, [HISTORY_MARKER]: marker }, '', window.location.href)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusable = () => Array.from(dialogRef.current?.querySelectorAll(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    ) || [])
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeInProgress.current = true
        window.history.back()
        onSnooze()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const first = items[0]
      const last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus()
      }
    }
    const onPopState = () => {
      if (!closeInProgress.current) onSnooze()
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('popstate', onPopState)
    requestAnimationFrame(() => dialogRef.current?.focus())

    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('popstate', onPopState)
      priorFocus.current?.focus?.()
    }
  }, [onSnooze, release])

  if (!release) return null

  const dismiss = (action, { preserveHistory = false } = {}) => {
    closeInProgress.current = true
    if (preserveHistory) {
      const state = { ...(window.history.state || {}) }
      delete state[HISTORY_MARKER]
      window.history.replaceState(state, '', window.location.href)
    } else if (window.history.state?.[HISTORY_MARKER]) {
      window.history.back()
    }
    action()
  }

  return (
    <div
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(onSnooze) }}
      style={{ position: 'fixed', inset: 0, zIndex: 120, display: 'grid', alignItems: 'end', justifyItems: 'center', background: 'rgba(0,0,0,0.78)', padding: '12px 12px calc(12px + env(safe-area-inset-bottom, 0px))' }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        className="w-full max-w-[480px] rounded-2xl p-5"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', maxHeight: 'min(82dvh, 720px)', overflowY: 'auto', boxSizing: 'border-box' }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-black uppercase" style={{ color: 'var(--accent)', letterSpacing: 0.8 }}>{t('whatsNew.eyebrow')}</p>
            <p className="mt-1 text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>Forged Hybrid</p>
          </div>
          <button type="button" onClick={() => dismiss(onSnooze)} aria-label={t('whatsNew.notNow')} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>
            <X size={20} />
          </button>
        </div>

        <div className="mt-4 flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}><Sparkles size={22} /></div>
        <h2 id="whats-new-title" className="mt-3 text-2xl font-black leading-tight" style={{ color: 'var(--text-primary)' }}>{t(release.titleKey)}</h2>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>{t(release.summaryKey)}</p>
        <ul className="mt-4 space-y-3">
          {release.highlightKeys.map((key) => (
            <li key={key} className="flex gap-3 text-sm leading-relaxed" style={{ color: 'var(--text-primary)' }}>
              <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--accent)' }} />
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>

        <div className="mt-5 grid gap-2">
          {release.cta && (
            <button type="button" onClick={() => dismiss(onCta, { preserveHistory: true })} className="min-h-11 rounded-xl px-4 py-3 text-sm font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none' }}>{t(release.cta.labelKey)}</button>
          )}
          <button type="button" onClick={() => dismiss(onAcknowledge)} className="min-h-11 rounded-xl px-4 py-3 text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>{t('whatsNew.gotIt')}</button>
          <button type="button" onClick={() => dismiss(onViewAll, { preserveHistory: true })} className="min-h-11 bg-transparent px-4 py-2 text-sm font-bold" style={{ color: 'var(--text-muted)', border: 'none' }}>{t('whatsNew.viewAll')}</button>
        </div>
      </section>
    </div>
  )
}
