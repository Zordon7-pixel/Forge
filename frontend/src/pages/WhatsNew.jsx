import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useReleaseNotes } from '../context/ReleaseNotesContext'

export default function WhatsNew() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { releases, acknowledge, markAllSeen } = useReleaseNotes()

  useEffect(() => { markAllSeen('more') }, [markAllSeen])

  return (
    <div className="space-y-4 pb-16">
      <header>
        <p className="text-xs font-black uppercase" style={{ color: 'var(--accent)', letterSpacing: 0.8 }}>{t('whatsNew.eyebrow')}</p>
        <h1 className="mt-1 text-3xl font-black" style={{ color: 'var(--text-primary)' }}>{t('whatsNew.pageTitle')}</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>{t('whatsNew.pageSubtitle')}</p>
      </header>

      {releases.length === 0 ? (
        <section className="rounded-xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{t('whatsNew.empty')}</p>
        </section>
      ) : releases.slice().reverse().map((release) => (
        <article key={release.id} className="rounded-xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}><Sparkles size={20} /></span>
            <div className="min-w-0">
              <time className="text-xs font-semibold" dateTime={release.publishedAt} style={{ color: 'var(--text-muted)' }}>{new Date(`${release.publishedAt}T12:00:00`).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}</time>
              <h2 className="mt-1 text-lg font-black" style={{ color: 'var(--text-primary)' }}>{t(release.titleKey)}</h2>
              <p className="mt-1 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>{t(release.summaryKey)}</p>
            </div>
          </div>
          <ul className="mt-4 space-y-2 pl-4 text-sm" style={{ color: 'var(--text-primary)' }}>
            {release.highlightKeys.map((key) => <li key={key} className="list-disc">{t(key)}</li>)}
          </ul>
          {release.delivery !== 'web' && <p className="mt-3 text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>{t('whatsNew.availableHere')}</p>}
          {release.cta && (
            <button
              type="button"
              onClick={() => acknowledge(release.sequence, { event: 'whats_new_cta', props: { surface: 'more', action: 'cta', value: release.sequence } }).then(() => navigate(release.cta.to))}
              className="mt-4 min-h-11 rounded-xl px-4 py-3 text-sm font-black"
              style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none' }}
            >{t(release.cta.labelKey)}</button>
          )}
        </article>
      ))}
    </div>
  )
}
