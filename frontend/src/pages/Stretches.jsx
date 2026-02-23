import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  Footprints,
  LayoutGrid,
  MoveUp,
  RefreshCw,
  Sparkles,
  CheckCircle2,
  ChevronRight,
  Check,
  X,
} from 'lucide-react'
import api from '../lib/api'

/* ─── Category icon map ─── */
const CATEGORY_ICONS = {
  'hip-focused': Activity,
  'leg-focused': Footprints,
  'full-body':   LayoutGrid,
  'upper-body':  MoveUp,
  'lower-back':  RefreshCw,
}

/* ─── Translation key map for category labels ─── */
const CATEGORY_KEY = {
  'hip-focused': 'stretches.hipFocused',
  'leg-focused': 'stretches.legFocused',
  'full-body':   'stretches.fullBody',
  'upper-body':  'stretches.upperBody',
  'lower-back':  'stretches.lowerBack',
}

/* ─── Countdown ring ─── */
const RING_R    = 44
const RING_CIRC = 2 * Math.PI * RING_R

function CountdownRing({ total, remaining }) {
  const pct    = remaining / total
  const offset = RING_CIRC * (1 - pct)
  return (
    <svg width="110" height="110" viewBox="0 0 110 110">
      <circle cx="55" cy="55" r={RING_R} fill="none" stroke="var(--bg-card)" strokeWidth="7" />
      <circle
        cx="55" cy="55" r={RING_R} fill="none"
        stroke="#EAB308" strokeWidth="7" strokeLinecap="round"
        strokeDasharray={RING_CIRC} strokeDashoffset={offset}
        style={{ transform: 'rotate(-90deg)', transformOrigin: '55px 55px', transition: 'stroke-dashoffset 1s linear' }}
      />
      <text
        x="55" y="55" textAnchor="middle" dominantBaseline="central"
        fill="#EAB308" fontSize="26" fontWeight="900" fontFamily="system-ui,sans-serif"
      >
        {remaining}
      </text>
    </svg>
  )
}

/* ─── Stretch session screen ─── */
function StretchSession({ stretches, onDone, onBack }) {
  const { t } = useTranslation()
  const [stepIndex, setStepIndex]       = useState(0)
  const [remaining, setRemaining]       = useState(stretches[0]?.duration || 30)
  const [phase, setPhase]               = useState('active') // active | transition | done
  const [transCountdown, setTransCount] = useState(3)
  const intervalRef = useRef(null)
  const transRef    = useRef(null)

  const stretch    = stretches[stepIndex]
  const nextStretch = stepIndex < stretches.length - 1 ? stretches[stepIndex + 1] : null
  const isLast     = stepIndex >= stretches.length - 1
  const progressPct = Math.round((stepIndex / stretches.length) * 100)

  // Reset state when step changes
  useEffect(() => {
    setRemaining(stretch.duration)
    setPhase('active')
    setTransCount(3)
  }, [stepIndex, stretch.duration])

  // Main countdown
  useEffect(() => {
    if (phase !== 'active') return
    intervalRef.current = setInterval(() => {
      setRemaining(prev => {
        if (prev <= 1) {
          clearInterval(intervalRef.current)
          setPhase(isLast ? 'done' : 'transition')
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(intervalRef.current)
  }, [phase, isLast])

  // Transition auto-advance
  useEffect(() => {
    if (phase !== 'transition') return
    setTransCount(3)
    let tc = 3
    transRef.current = setInterval(() => {
      tc -= 1
      setTransCount(tc)
      if (tc <= 0) {
        clearInterval(transRef.current)
        setStepIndex(prev => prev + 1)
      }
    }, 1000)
    return () => clearInterval(transRef.current)
  }, [phase])

  const handleNext = () => {
    clearInterval(intervalRef.current)
    clearInterval(transRef.current)
    if (isLast) {
      onDone()
    } else {
      setStepIndex(prev => prev + 1)
    }
  }

  const handleExit = () => {
    clearInterval(intervalRef.current)
    clearInterval(transRef.current)
    onBack()
  }

  return (
    <div style={{ background: 'var(--bg-base)', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Progress bar */}
      <div style={{ height: 3, background: 'var(--bg-input)' }}>
        <div style={{ height: '100%', background: '#EAB308', width: `${progressPct}%`, transition: 'width 0.3s ease' }} />
      </div>

      <div style={{ flex: 1, maxWidth: 480, margin: '0 auto', width: '100%', padding: '20px 16px 120px', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 13, fontWeight: 600 }}>
            {stepIndex + 1} {t('run.of')} {stretches.length}
          </span>
          <button
            onClick={handleExit}
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: '50%', width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            aria-label="Exit"
          >
            <X size={16} color="var(--text-muted)" />
          </button>
        </div>

        {/* Stretch name */}
        <h1 style={{ color: 'var(--text-primary)', fontWeight: 900, fontSize: 34, textTransform: 'uppercase', letterSpacing: -1, marginBottom: 6, textAlign: 'center', lineHeight: 1.1 }}>
          {stretch.name}
        </h1>
        <p style={{ color: '#EAB308', fontWeight: 700, fontSize: 13, textAlign: 'center', marginBottom: 24 }}>
          {stretch.durationLabel}
        </p>

        {/* Instruction */}
        <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.75, textAlign: 'center', marginBottom: 32, padding: '0 8px' }}>
          {stretch.cue}
        </p>

        {/* Timer */}
        {phase === 'active' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 24 }}>
            <CountdownRing total={stretch.duration} remaining={remaining} />
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 8 }}>{t('stretches.secsRemaining')}</p>
          </div>
        )}

        {/* Transition */}
        {phase === 'transition' && nextStretch && (
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 16, padding: 20, textAlign: 'center', marginBottom: 24 }}>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 6 }}>
              {t('stretches.nextUp')} {transCountdown}...
            </p>
            <p style={{ color: '#EAB308', fontWeight: 800, fontSize: 18 }}>{nextStretch.name}</p>
          </div>
        )}

        {/* Done state */}
        {phase === 'done' && (
          <div style={{ background: 'var(--bg-card)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 16, padding: 20, textAlign: 'center', marginBottom: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <Check size={28} color="#22c55e" />
            <p style={{ color: '#22c55e', fontWeight: 800, fontSize: 16 }}>
              {isLast ? t('stretches.routineComplete') : t('stretches.stretchComplete')}
            </p>
          </div>
        )}

        <div style={{ flex: 1 }} />
      </div>

      {/* Fixed bottom buttons */}
      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, padding: '12px 16px 28px', background: 'var(--bg-base)', borderTop: '1px solid var(--border-subtle)' }}>
        <div style={{ maxWidth: 480, margin: '0 auto', display: 'flex', gap: 12 }}>
          <button
            onClick={handleExit}
            style={{ flex: 1, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 14, padding: '14px 0', fontSize: 14, fontWeight: 600, color: 'var(--text-muted)', cursor: 'pointer' }}
          >
            {t('common.done')}
          </button>
          {phase !== 'done' && (
            <button
              onClick={handleNext}
              style={{ flex: 2, background: '#EAB308', border: 'none', borderRadius: 14, padding: '14px 0', fontSize: 14, fontWeight: 900, color: '#000', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
            >
              {nextStretch
                ? <>{t('common.next')} <ChevronRight size={16} /></>
                : <>{t('stretches.finish')} <Check size={16} /></>
              }
            </button>
          )}
          {phase === 'done' && (
            <button
              onClick={onDone}
              style={{ flex: 2, background: '#22c55e', border: 'none', borderRadius: 14, padding: '14px 0', fontSize: 14, fontWeight: 900, color: '#000', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
            >
              <Check size={16} /> {t('common.done')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ─── Main page ─── */
export default function Stretches() {
  const { t } = useTranslation()

  const [screen, setScreen]       = useState('categories') // categories | loading | ai-banner | session | done
  const [categories, setCategories] = useState([])
  const [stretches, setStretches] = useState([])
  const [aiData, setAiData]       = useState(null) // { recommendedCategory, reason }
  const [doneCount, setDoneCount] = useState(0)

  useEffect(() => {
    api.get('/stretches/categories')
      .then(r => setCategories(r.data.categories))
      .catch(() => {})
  }, [])

  const loadCategory = async (categoryId) => {
    setScreen('loading')
    try {
      const r = await api.get(`/stretches?category=${categoryId}`)
      setStretches(r.data.stretches)
      setScreen('session')
    } catch {
      setScreen('categories')
    }
  }

  const loadAI = async () => {
    setScreen('loading')
    try {
      const r = await api.get('/stretches/recommended')
      setAiData({
        recommendedCategory: r.data.recommendedCategory,
        reason: r.data.reason,
      })
      setStretches(r.data.stretches)
      setScreen('ai-banner')
    } catch {
      setScreen('categories')
    }
  }

  const handleSessionDone = () => {
    setDoneCount(stretches.length)
    setScreen('done')
  }

  /* ── Loading ── */
  if (screen === 'loading') {
    return (
      <div style={{ background: 'var(--bg-base)', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: 15 }}>{t('common.loading')}</p>
      </div>
    )
  }

  /* ── AI Banner ── */
  if (screen === 'ai-banner' && aiData) {
    const Icon    = CATEGORY_ICONS[aiData.recommendedCategory] || LayoutGrid
    const catKey  = CATEGORY_KEY[aiData.recommendedCategory]
    const catLabel = catKey ? t(catKey) : aiData.recommendedCategory

    return (
      <div style={{ background: 'var(--bg-base)', minHeight: '100vh', padding: '32px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ maxWidth: 480, width: '100%' }}>
          {/* Badge */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(234,179,8,0.1)', border: '1px solid rgba(234,179,8,0.25)', borderRadius: 20, padding: '6px 14px', marginBottom: 28 }}>
            <Sparkles size={14} color="#EAB308" />
            <span style={{ color: '#EAB308', fontWeight: 700, fontSize: 12 }}>{t('stretches.aiRecommended')}</span>
          </div>

          <h1 style={{ color: 'var(--text-primary)', fontWeight: 900, fontSize: 30, marginBottom: 8 }}>
            {t('stretches.recommendedFor')}
          </h1>

          {/* Category card */}
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 20, padding: 24, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
              <div style={{ width: 52, height: 52, borderRadius: 14, background: 'rgba(234,179,8,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon size={24} color="#EAB308" />
              </div>
              <div>
                <p style={{ color: 'var(--text-primary)', fontWeight: 800, fontSize: 20, margin: 0 }}>{catLabel}</p>
                <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>{stretches.length} {t('stretches.stretchesReady')}</p>
              </div>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6, margin: 0 }}>{aiData.reason}</p>
          </div>

          <button
            onClick={() => setScreen('session')}
            style={{ width: '100%', background: '#EAB308', color: '#000', border: 'none', borderRadius: 16, padding: '16px 0', fontWeight: 900, fontSize: 16, cursor: 'pointer', marginBottom: 12 }}
          >
            {t('stretches.begin')}
          </button>
          <button
            onClick={() => setScreen('categories')}
            style={{ width: '100%', background: 'transparent', color: 'var(--text-muted)', border: 'none', padding: '12px 0', cursor: 'pointer', fontSize: 14 }}
          >
            {t('common.back')}
          </button>
        </div>
      </div>
    )
  }

  /* ── Session ── */
  if (screen === 'session') {
    return (
      <StretchSession
        stretches={stretches}
        onDone={handleSessionDone}
        onBack={() => setScreen('categories')}
      />
    )
  }

  /* ── Completion ── */
  if (screen === 'done') {
    return (
      <div style={{ background: 'var(--bg-base)', minHeight: '100vh', padding: '24px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ maxWidth: 480, width: '100%', textAlign: 'center' }}>
          <CheckCircle2 size={72} color="#EAB308" style={{ marginBottom: 20 }} />
          <h1 style={{ color: 'var(--text-primary)', fontWeight: 900, fontSize: 32, marginBottom: 10 }}>
            {t('stretches.completionTitle')}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 15, marginBottom: 40 }}>
            {doneCount} {t('stretches.completionSubtitle')}
          </p>
          <button
            onClick={() => setScreen('categories')}
            style={{ width: '100%', background: '#EAB308', color: '#000', border: 'none', borderRadius: 16, padding: '16px 0', fontWeight: 900, fontSize: 16, cursor: 'pointer' }}
          >
            {t('stretches.startAnother')}
          </button>
        </div>
      </div>
    )
  }

  /* ── Category picker (default) ── */
  return (
    <div style={{ background: 'var(--bg-base)', minHeight: '100vh', padding: '24px 16px 96px' }}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        <header style={{ marginBottom: 28 }}>
          <h1 style={{ color: 'var(--text-primary)', fontWeight: 900, fontSize: 28, marginBottom: 6 }}>
            {t('stretches.title')}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>{t('stretches.subtitle')}</p>
        </header>

        {/* AI Recommended */}
        <button
          onClick={loadAI}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 14,
            background: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.22)',
            borderRadius: 16, padding: '16px 20px', cursor: 'pointer', marginBottom: 24,
            textAlign: 'left',
          }}
        >
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(234,179,8,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Sparkles size={20} color="#EAB308" />
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ color: '#EAB308', fontWeight: 800, fontSize: 15, margin: 0 }}>{t('stretches.aiRecommended')}</p>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}>{t('stretches.aiRecommendedDesc')}</p>
          </div>
          <ChevronRight size={18} color="var(--text-muted)" />
        </button>

        {/* Section label */}
        <p style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>
          {t('stretches.categories')}
        </p>

        {/* Category grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {categories.map(cat => {
            const Icon  = CATEGORY_ICONS[cat.id] || Activity
            const label = CATEGORY_KEY[cat.id] ? t(CATEGORY_KEY[cat.id]) : cat.label
            return (
              <button
                key={cat.id}
                onClick={() => loadCategory(cat.id)}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12,
                  background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
                  borderRadius: 16, padding: '18px 16px', cursor: 'pointer', textAlign: 'left',
                }}
              >
                <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(234,179,8,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon size={18} color="#EAB308" />
                </div>
                <span style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 14, lineHeight: 1.2 }}>
                  {label}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
