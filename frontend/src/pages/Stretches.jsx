import { useEffect, useState } from 'react'
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
  X,
} from 'lucide-react'
import api from '../lib/api'
import GuidedMovementTimer from '../components/GuidedMovementTimer'
import MovementDemo from '../components/MovementDemo'
import { normalizeProfileSex } from '../lib/exerciseGuidePolicy'
import { getMostRecentRoutineIds, getPreviousRoutineIds, rememberRoutine } from '../lib/routineRotation'
import { SWIPE_BACK_EVENT } from '../lib/swipeBack'

const STRETCH_ROTATION_SCOPE = 'stretch-library'
const ROUTINE_SIZES = [
  { count: 5, label: 'Quick Reset' },
  { count: 8, label: 'Daily Runner' },
  { count: 12, label: 'Full Mobility' },
]

function estimateRoutineSeconds(stretches) {
  return (Array.isArray(stretches) ? stretches : []).reduce((total, stretch) => {
    const duration = Number(stretch?.duration)
    if (!Number.isFinite(duration) || duration < 0) return total
    return total + duration * (stretch?.sides === 2 ? 2 : 1)
  }, 0)
}

function formatEstimatedTime(seconds) {
  const minutes = Math.max(1, Math.ceil(Number(seconds || 0) / 60))
  return `About ${minutes} min`
}

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

const TIGHTNESS_OPTIONS = [
  { id: 'hips', label: 'Hips', category: 'hip-focused' },
  { id: 'hamstrings', label: 'Hamstrings', category: 'leg-focused' },
  { id: 'calves', label: 'Calves', category: 'leg-focused' },
  { id: 'lower-back', label: 'Lower back', category: 'lower-back' },
  { id: 'shoulders', label: 'Shoulders', category: 'upper-body' },
  { id: 'full-body', label: 'Full body', category: 'full-body' },
]

/* ─── Stretch session screen ─── */
function StretchSession({ stretches, estimatedSeconds, onDone, onBack, sex = '' }) {
  const { t } = useTranslation()
  const [stepIndex, setStepIndex] = useState(0)

  const stretch = stretches[stepIndex]
  const nextStretch = stepIndex < stretches.length - 1 ? stretches[stepIndex + 1] : null
  const isLast = stepIndex >= stretches.length - 1
  const progressPct = Math.round((stepIndex / stretches.length) * 100)

  const advance = () => {
    if (isLast) {
      onDone()
    } else {
      setStepIndex(value => value + 1)
    }
  }

  const goPrevious = () => {
    if (stepIndex > 0) setStepIndex(value => value - 1)
  }

  return (
    <div style={{ background: 'var(--bg-base)', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Progress bar */}
      <div style={{ height: 3, background: 'var(--bg-input)' }}>
        <div style={{ height: '100%', background: 'var(--accent)', width: `${progressPct}%`, transition: 'width 0.3s ease' }} />
      </div>

      <div style={{ flex: 1, maxWidth: 480, margin: '0 auto', width: '100%', padding: '20px 16px 220px', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
          <div>
            <span style={{ color: 'var(--text-muted)', fontSize: 13, fontWeight: 600 }}>
              {stepIndex + 1} {t('run.of')} {stretches.length}
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> · {formatEstimatedTime(estimatedSeconds)} total</span>
          </div>
          <button
            onClick={onBack}
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: '50%', width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            aria-label="Exit"
          >
            <X size={16} color="var(--text-muted)" />
          </button>
        </div>

        {/* Stretch name */}
        <h1 style={{ color: 'var(--text-primary)', fontWeight: 900, fontSize: 34, textTransform: 'uppercase', letterSpacing: -1, marginBottom: 6, textAlign: 'center', lineHeight: 1.1 }}>
          {stretch.name}
        </h1>
        <p style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 13, textAlign: 'center', marginBottom: 24 }}>
          {stretch.durationLabel}
        </p>

        {/* Instruction */}
        <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.75, textAlign: 'center', marginBottom: 32, padding: '0 8px' }}>
          {stretch.cue}
        </p>

        <MovementDemo name={stretch.name} compact sex={sex} imageUrl={stretch.image_url || stretch.imageUrl} cue={stretch.cue} />

        <GuidedMovementTimer
          key={'library:' + stepIndex + ':' + stretch.id}
          movement={stretch}
          movementKey={'library:' + stepIndex + ':' + stretch.id}
          onComplete={advance}
          onSkip={advance}
          onPrevious={goPrevious}
          canPrevious={stepIndex > 0}
          skipLabel={nextStretch ? 'Skip' : 'Skip and finish'}
        />

        <div style={{ flex: 1 }} />
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
  const [routineCount, setRoutineCount] = useState(8)
  const [estimatedSeconds, setEstimatedSeconds] = useState(0)
  const [sex, setSex]             = useState(null)
  const [profileReady, setProfileReady] = useState(false)

  useEffect(() => {
    api.get('/stretches/categories')
      .then(r => setCategories(r.data.categories))
      .catch((err) => console.error('[stretches] category load failed:', err?.message || err))
    api.get('/auth/me')
      .then((r) => setSex(normalizeProfileSex(r.data?.user?.sex || r.data?.sex)))
      .catch((err) => {
        console.error('[stretches] profile load failed:', err?.message || err)
        setSex('')
      })
      .finally(() => setProfileReady(true))
  }, [])

  useEffect(() => {
    if (screen === 'categories' || screen === 'loading') return undefined
    const returnToCategories = (event) => {
      event.preventDefault()
      setScreen('categories')
    }
    window.addEventListener(SWIPE_BACK_EVENT, returnToCategories)
    return () => window.removeEventListener(SWIPE_BACK_EVENT, returnToCategories)
  }, [screen])

  const loadCategory = async (categoryId) => {
    setScreen('loading')
    try {
      const exclude = getPreviousRoutineIds(STRETCH_ROTATION_SCOPE)
      const previous = getMostRecentRoutineIds(STRETCH_ROTATION_SCOPE)
      const r = await api.get('/stretches', {
        params: { category: categoryId, count: routineCount, exclude: exclude.join(','), previous: previous.join(',') },
      })
      rememberRoutine(STRETCH_ROTATION_SCOPE, r.data.stretches)
      setStretches(r.data.stretches)
      setEstimatedSeconds(estimateRoutineSeconds(r.data.stretches))
      setScreen('session')
    } catch (err) {
      console.error('[stretches] category routine load failed:', err?.message || err)
      setScreen('categories')
    }
  }

  const loadAI = async () => {
    setScreen('loading')
    try {
      const exclude = getPreviousRoutineIds(STRETCH_ROTATION_SCOPE)
      const previous = getMostRecentRoutineIds(STRETCH_ROTATION_SCOPE)
      const r = await api.get('/stretches/recommended', {
        params: { count: routineCount, exclude: exclude.join(','), previous: previous.join(',') },
      })
      rememberRoutine(STRETCH_ROTATION_SCOPE, r.data.stretches)
      setAiData({
        recommendedCategory: r.data.recommendedCategory,
        reason: r.data.reason,
      })
      setStretches(r.data.stretches)
      setEstimatedSeconds(estimateRoutineSeconds(r.data.stretches))
      setScreen('ai-banner')
    } catch (err) {
      console.error('[stretches] recommended routine load failed:', err?.message || err)
      setScreen('categories')
    }
  }

  const handleSessionDone = () => {
    setDoneCount(stretches.length)
    setScreen('done')
  }

  /* ── Loading ── */
  if (!profileReady || screen === 'loading') {
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
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)', borderRadius: 20, padding: '6px 14px', marginBottom: 28 }}>
            <Sparkles size={14} color="var(--accent)" />
            <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 12 }}>{t('stretches.aiRecommended')}</span>
          </div>

          <h1 style={{ color: 'var(--text-primary)', fontWeight: 900, fontSize: 30, marginBottom: 8 }}>
            {t('stretches.recommendedFor')}
          </h1>

          {/* Category card */}
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 20, padding: 24, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
              <div style={{ width: 52, height: 52, borderRadius: 14, background: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon size={24} color="var(--accent)" />
              </div>
              <div>
                <p style={{ color: 'var(--text-primary)', fontWeight: 800, fontSize: 20, margin: 0 }}>{catLabel}</p>
                <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
                  {stretches.length} {t('stretches.stretchesReady')} · {formatEstimatedTime(estimatedSeconds)}
                </p>
              </div>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6, margin: 0 }}>{aiData.reason}</p>
          </div>

          <button
            onClick={() => setScreen('session')}
            style={{ width: '100%', background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', borderRadius: 16, padding: '16px 0', fontWeight: 900, fontSize: 16, cursor: 'pointer', marginBottom: 12 }}
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
        estimatedSeconds={estimatedSeconds}
        onDone={handleSessionDone}
        onBack={() => setScreen('categories')}
        sex={sex}
      />
    )
  }

  /* ── Completion ── */
  if (screen === 'done') {
    return (
      <div style={{ background: 'var(--bg-base)', minHeight: '100vh', padding: '24px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ maxWidth: 480, width: '100%', textAlign: 'center' }}>
          <CheckCircle2 size={72} color="var(--accent)" style={{ marginBottom: 20 }} />
          <h1 style={{ color: 'var(--text-primary)', fontWeight: 900, fontSize: 32, marginBottom: 10 }}>
            {t('stretches.completionTitle')}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 15, marginBottom: 40 }}>
            {doneCount} {t('stretches.completionSubtitle')}
          </p>
          <button
            onClick={() => setScreen('categories')}
            style={{ width: '100%', background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', borderRadius: 16, padding: '16px 0', fontWeight: 900, fontSize: 16, cursor: 'pointer' }}
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

        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 18, padding: 16, marginBottom: 16 }}>
          <p style={{ color: 'var(--text-primary)', fontWeight: 900, fontSize: 17, margin: 0 }}>Routine length</p>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 14px' }}>Choose the amount of mobility work for this session.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
            {ROUTINE_SIZES.map(option => (
              <button
                key={option.count}
                type="button"
                aria-pressed={routineCount === option.count}
                onClick={() => setRoutineCount(option.count)}
                style={{
                  background: routineCount === option.count ? 'var(--accent-dim)' : 'var(--bg-input)',
                  border: `1px solid ${routineCount === option.count ? 'var(--accent)' : 'var(--border-subtle)'}`,
                  borderRadius: 12,
                  color: routineCount === option.count ? 'var(--accent)' : 'var(--text-primary)',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 800,
                  minHeight: 64,
                  padding: '8px 4px',
                }}
              >
                {option.label} · {option.count}
              </button>
            ))}
          </div>
        </div>

        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 18, padding: 16, marginBottom: 16 }}>
          <p style={{ color: 'var(--text-primary)', fontWeight: 900, fontSize: 17, margin: 0 }}>
            Where do you feel tight?
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 14px' }}>
            Pick the area and Forged Hybrid will rotate a focused mobility set.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {TIGHTNESS_OPTIONS.map(option => (
              <button
                key={option.id}
                type="button"
                onClick={() => loadCategory(option.category)}
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 13,
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 800,
                  padding: '12px 10px',
                  textAlign: 'left',
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {/* AI Recommended */}
        <button
          onClick={loadAI}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 14,
            background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)',
            borderRadius: 16, padding: '16px 20px', cursor: 'pointer', marginBottom: 24,
            textAlign: 'left',
          }}
        >
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Sparkles size={20} color="var(--accent)" />
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ color: 'var(--accent)', fontWeight: 800, fontSize: 15, margin: 0 }}>{t('stretches.aiRecommended')}</p>
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
                <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon size={18} color="var(--accent)" />
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
