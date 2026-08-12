import { useEffect, useRef, useState } from 'react'
import { CircleHelp, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import api from '../lib/api'
import { getToken } from '../lib/tokenStore'
import MovementDemo from './MovementDemo'

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
let cachedProfile = { token: '', sex: '', resolved: false, promise: null }

export function normalizeExerciseGuide(exercise = {}) {
  const source = exercise && typeof exercise === 'object' ? exercise : { name: exercise }
  const name = source.name || source.exercise || source.exercise_name || 'Exercise'
  return {
    name: String(name),
    cue: String(source.cue || source.formCue || source.instructions || source.notes || ''),
    imageUrl: String(source.image_url || source.imageUrl || source.how_to_image_url || ''),
    sets: source.sets || '',
    reps: source.reps || '',
    rest: source.rest || '',
    load: source.load || source.weight || '',
    effort: source.rpe || source.rir || '',
  }
}

async function loadProfileSex() {
  const token = getToken() || ''
  if (cachedProfile.token === token && cachedProfile.resolved) return cachedProfile.sex
  if (cachedProfile.token === token && cachedProfile.promise) return cachedProfile.promise

  const promise = api.get('/auth/me')
    .then((response) => {
      const sex = String(response.data?.user?.sex || '').toLowerCase()
      cachedProfile = { token, sex: sex === 'female' || sex === 'male' ? sex : '', resolved: true, promise: null }
      return cachedProfile.sex
    })
    .catch((error) => {
      console.error('[exercise-guide] profile load failed:', error?.message || error)
      cachedProfile = { token, sex: '', resolved: true, promise: null }
      return ''
    })

  cachedProfile = { token, sex: '', resolved: false, promise }
  return promise
}

function ExerciseGuideDialog({ exercise, sex = '', onClose }) {
  const guide = normalizeExerciseGuide(exercise)
  const dialogRef = useRef(null)
  const closeRef = useRef(null)

  useEffect(() => {
    const body = document.body
    const previousOverflow = body.style.overflow
    const previousOverscroll = body.style.overscrollBehavior
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    body.style.overflow = 'hidden'
    body.style.overscrollBehavior = 'none'
    requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }))

    return () => {
      body.style.overflow = previousOverflow
      body.style.overscrollBehavior = previousOverscroll
      previousFocus?.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', closeOnEscape, true)
    return () => document.removeEventListener('keydown', closeOnEscape, true)
  }, [onClose])

  const handleKeyDown = (event) => {
    event.stopPropagation()
    if (event.key !== 'Tab') return
    const focusable = Array.from(dialogRef.current?.querySelectorAll(FOCUSABLE) || [])
    if (!focusable.length) {
      event.preventDefault()
      dialogRef.current?.focus()
      return
    }
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const prescription = [
    guide.sets ? { label: 'Sets', value: guide.sets } : null,
    guide.reps ? { label: 'Reps', value: guide.reps } : null,
    guide.rest ? { label: 'Rest', value: guide.rest } : null,
    guide.load ? { label: 'Load', value: guide.load } : null,
    guide.effort ? { label: 'RPE/RIR', value: guide.effort } : null,
  ].filter(Boolean)

  return createPortal(
    <div
      data-exercise-guide-dialog="true"
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
      onKeyDown={handleKeyDown}
      style={{ position: 'fixed', inset: 0, zIndex: 150, display: 'grid', alignItems: 'end', justifyItems: 'center', background: 'rgba(0,0,0,0.8)', padding: '12px 12px calc(12px + env(safe-area-inset-bottom, 0px))' }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="exercise-guide-title"
        className="w-full max-w-[520px]"
        style={{ maxHeight: 'min(88dvh, 820px)', overflowY: 'auto', overscrollBehavior: 'contain', borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', padding: 16 }}
      >
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase" style={{ color: 'var(--accent)', letterSpacing: 1.1 }}>Exercise guide</p>
            <h2 id="exercise-guide-title" className="mt-1 break-words text-2xl font-black" style={{ color: 'var(--text-primary)' }}>{guide.name}</h2>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close exercise guide" className="grid h-11 w-11 shrink-0 place-items-center rounded-lg" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
            <X size={20} />
          </button>
        </header>

        {prescription.length > 0 && (
          <div className="mt-4 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(prescription.length, 3)}, minmax(0, 1fr))` }}>
            {prescription.map((item) => (
              <div key={item.label} className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', minWidth: 0 }}>
                <p className="text-[10px] font-black uppercase" style={{ color: 'var(--text-muted)' }}>{item.label}</p>
                <p className="mt-1 break-words text-sm font-black" style={{ color: 'var(--text-primary)' }}>{String(item.value)}</p>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4">
          <MovementDemo name={guide.name} cue={guide.cue} imageUrl={guide.imageUrl} sex={sex} />
        </div>

        <p className="mt-4 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Stop if the movement causes sharp pain or changes your normal mechanics. Use a lighter load until the motion is controlled.
        </p>
      </section>
    </div>,
    document.body,
  )
}

export default function ExerciseGuideAction({ exercise, sex = '', className = '' }) {
  const [open, setOpen] = useState(false)
  const [profileSex, setProfileSex] = useState(sex)

  useEffect(() => {
    if (sex) setProfileSex(sex)
  }, [sex])

  useEffect(() => {
    if (!open || profileSex) return undefined
    let active = true
    loadProfileSex().then((value) => {
      if (active) setProfileSex(value)
    })
    return () => { active = false }
  }, [open, profileSex])

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-black ${className}`.trim()}
        style={{ background: 'var(--bg-input)', color: 'var(--accent)', border: '1px solid var(--border-subtle)' }}
      >
        <CircleHelp size={16} aria-hidden="true" />
        View how
      </button>
      {open && <ExerciseGuideDialog exercise={exercise} sex={profileSex} onClose={() => setOpen(false)} />}
    </>
  )
}
