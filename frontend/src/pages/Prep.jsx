import React, { Suspense, lazy } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import LoadingRunner from '../components/LoadingRunner'

const Warmup = lazy(() => import('./Warmup'))
const Stretches = lazy(() => import('./Stretches'))

export default function Prep() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const mode = searchParams.get('mode') === 'recovery' ? 'recovery' : 'warmup'

  const setMode = (nextMode) => {
    setSearchParams({ mode: nextMode }, { replace: true })
  }

  const tabs = [
    { mode: 'warmup', label: t('prep.warmupTab') },
    { mode: 'recovery', label: t('prep.recoveryTab') },
  ]

  return (
    <div className="space-y-4 pb-16">
      <header>
        <p style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>Forged Hybrid</p>
        <h1 style={{ color: 'var(--text-primary)', fontSize: 28, fontWeight: 900, margin: 0 }}>{t('prep.title')}</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>{t('prep.subtitle')}</p>
      </header>

      <div className="grid grid-cols-2 gap-2 rounded-2xl p-1" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        {tabs.map((tab) => {
          const active = mode === tab.mode
          return (
            <button
              key={tab.mode}
              type="button"
              onClick={() => setMode(tab.mode)}
              className="rounded-xl px-3 py-2 text-sm font-black"
              style={{
                background: active ? 'var(--accent)' : 'transparent',
                color: active ? '#000' : 'var(--text-primary)',
                border: 'none',
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      <Suspense fallback={<LoadingRunner />}>
        {mode === 'recovery' ? <Stretches /> : <Warmup />}
      </Suspense>
    </div>
  )
}
