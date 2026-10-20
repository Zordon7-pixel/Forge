import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download, ImagePlus, Share2, Users, X } from 'lucide-react'
import { useNavigate } from 'react-router'
import api from '../lib/api'
import { createActionSingleFlight } from '../lib/actionSingleFlight'
import { unreadableActivitySharePhotoMessage, validateActivitySharePhoto } from '../lib/activitySharePhoto'
import { SIZES, loadShareFonts } from '../lib/shareTheme'
import { TEMPLATES, availableShareTemplates, resolveShareTemplate, drawShareCard, titleForModel, drawBrand, roundRect } from '../lib/shareTemplates'
import { studioModel, sharePreferences, activityShareModels } from '../lib/shareStudioModel'
import PhotoLibraryService from '../services/PhotoLibraryService'

const CARD_WIDTH = SIZES.feed.w
const CARD_HEIGHT = SIZES.feed.h
const MODAL_FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

// Card headline quotes — kept ≤21 chars so they fit every template's title line
const FORGED_QUOTES = [
  'Forged, not finished.',
  'Effort is heat.',
  'The work adds up.',
  'Struck while hot.',
  'Earned, not given.',
  'Miles and iron.',
  'Run far. Lift heavy.',
  'Built by the hammer.',
  'Chase the white-hot.',
  'Forge day. Every day.',
]

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Image could not be loaded'))
    image.src = src
  })
}

function captionForModel(model) {
  return [titleForModel(model), ...model.stats.filter(item => ['distance', 'time', 'pace'].includes(item.key)).map(item => `${item.value}${item.unit ? ` ${item.unit}` : ''}`)].join(' · ') + '\nForged Hybrid'
}

export function canvasBlob(canvas, mimeType = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Share card could not be created'))
    }, mimeType, quality)
  })
}

export function resizedCanvas(source, width) {
  const canvas = document.createElement('canvas')
  const gcd = (a, b) => b ? gcd(b, a % b) : a
  const divisor = gcd(source.width, source.height)
  const aspectWidth = source.width / divisor, aspectHeight = source.height / divisor
  const scale = Math.max(1, Math.floor(width / aspectWidth))
  canvas.width = aspectWidth * scale
  canvas.height = aspectHeight * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Share card could not be resized')
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

export function cardDataForPost(source, transparent) {
  const widths = [720, 600, 480]
  const qualities = transparent ? [undefined] : [0.84, 0.74, 0.64]
  const mimeType = transparent ? 'image/png' : 'image/jpeg'
  for (const width of widths) {
    const canvas = resizedCanvas(source, width)
    for (const quality of qualities) {
      const data = canvas.toDataURL(mimeType, quality)
      if (data.length <= 980000) return { data, mimeType }
    }
  }
  throw new Error('Share card is too large to post')
}

function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate
    } else {
      lines.push(line)
      line = word
    }
    if (lines.length === maxLines) break
  }
  if (line && lines.length < maxLines) lines.push(line)
  lines.forEach((entry, index) => ctx.fillText(entry, x, y + index * lineHeight))
}

function drawSummaryTemplate(ctx, summary, logo) {
  ctx.fillStyle = '#080808'
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  ctx.save()
  ctx.strokeStyle = 'rgba(245,189,2,0.12)'
  ctx.lineWidth = 3
  for (let row = 0; row < 12; row += 1) {
    ctx.beginPath()
    for (let x = -70; x <= CARD_WIDTH + 70; x += 18) {
      const y = 240 + row * 76 + Math.sin((x + row * 47) / 88) * 24
      if (x === -70) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  ctx.restore()
  drawBrand(ctx, logo)

  ctx.fillStyle = '#EAB308'
  ctx.font = '900 28px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(String(summary?.eyebrow || 'Hybrid Score').toUpperCase(), 76, 265)
  ctx.fillStyle = '#FFFFFF'
  ctx.font = '950 132px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(String(summary?.primary || ''), 72, 410)
  ctx.fillStyle = '#D4D4D8'
  ctx.font = '700 30px -apple-system, BlinkMacSystemFont, sans-serif'
  drawWrappedText(ctx, summary?.subtitle || 'Run and lift balance sets the ceiling.', 80, 482, 920, 42, 3)

  const metrics = Array.isArray(summary?.metrics) ? summary.metrics.slice(0, 4) : []
  roundRect(ctx, 60, 650, 960, 420, 28, 'rgba(16,16,18,0.95)', '#2A2A2E')
  metrics.forEach((metric, index) => {
    const y = 735 + index * 86
    const value = Math.max(0, Math.min(100, Math.round(Number(metric?.value || 0))))
    ctx.fillStyle = '#A1A1AA'
    ctx.font = '800 25px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.fillText(String(metric?.label || 'Metric').toUpperCase(), 104, y)
    roundRect(ctx, 338, y - 22, 506, 28, 14, '#2A2A2E')
    const fillWidth = Math.round(506 * (value / 100))
    if (fillWidth > 0) roundRect(ctx, 338, y - 22, fillWidth, 28, 14, metric?.color || '#EAB308')
    ctx.fillStyle = '#FFFFFF'
    ctx.font = '900 32px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(String(metric?.display || value), 930, y + 4)
    ctx.textAlign = 'left'
  })

  ctx.fillStyle = '#EAB308'
  ctx.font = '900 34px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText('RUN + LIFT. BUILT IN FORGED HYBRID.', 80, 1212)
}

function summaryFilename(summary) {
  const slug = String(summary?.filename || summary?.eyebrow || 'hybrid-score')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 54) || 'hybrid-score'
  return `forged-${slug}.jpg`
}

function summaryShareText(summary) {
  const metricText = Array.isArray(summary?.metrics) && summary.metrics.length
    ? summary.metrics.map((metric) => `${metric.label}: ${metric.display || Math.round(Number(metric.value || 0))}`).join(' · ')
    : ''
  return [summary?.title || 'Forged Hybrid', summary?.primary, metricText, 'Forged Hybrid'].filter(Boolean).join('\n')
}

export async function shareSummaryCard(summary) {
  const canvas = document.createElement('canvas')
  canvas.width = CARD_WIDTH
  canvas.height = CARD_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Share card could not be created')
  let logo = null
  try {
    logo = await loadImage('/icon-192.png')
  } catch (error) {
    console.error('[ActivityShareStudio] logo load failed:', error?.message || error)
  }
  await loadShareFonts()
  drawSummaryTemplate(ctx, summary, logo)
  const file = new File([await canvasBlob(canvas, 'image/jpeg', 0.92)], summaryFilename(summary), { type: 'image/jpeg' })
  const shareData = { title: summary?.title || 'Forged Hybrid', text: summaryShareText(summary), files: [file] }
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    await navigator.share(shareData)
    return { method: 'share' }
  }
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  link.click()
  URL.revokeObjectURL(url)
  return { method: 'download' }
}

export default function ActivityShareStudio({ run, model, prefs, onClose }) {
  const navigate = useNavigate()
  const canvasRef = useRef(null)
  const dialogRef = useRef(null)
  const closeButtonRef = useRef(null)
  const fileInputRef = useRef(null)
  const ownedPhotoUrlsRef = useRef(new Set())
  const photoSelectionVersionRef = useRef(0)
  const onCloseRef = useRef(onClose)
  const actionLaneRef = useRef(null)
  if (!actionLaneRef.current) actionLaneRef.current = createActionSingleFlight()
  const photoInputId = useId()
  const photoFeedbackId = `${photoInputId}-feedback`
  const [requestedTemplate, setTemplate] = useState(() => prefs?.template || null)
  const [theme, setTheme] = useState('dark')
  const [size, setSize] = useState('feed')
  const [showRoute, setShowRoute] = useState(true)
  const [preferences, setPreferences] = useState(() => sharePreferences(prefs))
  const [preferencesReady, setPreferencesReady] = useState(Boolean(model || prefs))
  const [activityContext, setActivityContext] = useState(null)
  const [hybridSelected, setHybridSelected] = useState(false)
  const [renderReady, setRenderReady] = useState(false)
  const renderPromiseRef = useRef(null)
  const renderVersionRef = useRef(0)
  const [photoUrl, setPhotoUrl] = useState('')
  const [photoFeedback, setPhotoFeedback] = useState({ kind: '', message: '' })
  const [caption, setCaption] = useState('')
  const [cardTitle, setCardTitle] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [posted, setPosted] = useState(false)
  const activities = useMemo(() => model ? null : activityShareModels(run, activityContext, preferences, showRoute), [run, model, activityContext, preferences, showRoute])
  const cardModel = useMemo(() => studioModel({ run, model, prefs: preferences, showRoute, title: cardTitle, context: activityContext, hybrid: hybridSelected }), [run, model, preferences, showRoute, cardTitle, activityContext, hybridSelected])
  const availableTemplates = availableShareTemplates(cardModel, { showRoute, size })
  const template = resolveShareTemplate(cardModel, { template: requestedTemplate, showRoute, size })
  const transparent = template !== 'full-bleed-story' && !photoUrl
  const fileType = transparent ? 'image/png' : 'image/jpeg'
  const fileExtension = transparent ? 'png' : 'jpg'
  const filename = `forged-hybrid-${cardModel.kind}-${cardModel.dateLabel || 'activity'}-${size}.${fileExtension}`
  const usesLegacyPhotoSave = PhotoLibraryService.isNativeRuntime() && !PhotoLibraryService.isDirectSaveAvailable()

  useEffect(() => {
    let cancelled = false
    if (model || prefs) {
      setPreferences(sharePreferences(prefs))
      setPreferencesReady(true)
      return
    }
    setPreferencesReady(false)
    Promise.allSettled([api.get('/auth/me'), api.get('/users/settings')]).then(([profile, settings]) => {
      if (cancelled) return
      const user = profile.status === 'fulfilled' ? profile.value.data?.user || profile.value.data : {}
      const saved = settings.status === 'fulfilled' ? settings.value.data : {}
      setPreferences(sharePreferences({ units: saved?.units || user?.units,
        distance_unit: saved?.distance_unit, timezone: saved?.timezone,
        friend_handle: user?.friend_handle }, user?.timezone))
      if (profile.status === 'rejected' || settings.status === 'rejected') {
        console.warn('[ActivityShareStudio] share preferences unavailable')
        setStatus('Some share preferences could not be loaded. Available settings are used.')
      }
      setPreferencesReady(true)
    })
    return () => { cancelled = true }
  }, [model, prefs])

  const activityDay = activities?.run.dateLabel
  useEffect(() => {
    let cancelled = false
    setActivityContext(null)
    setHybridSelected(false)
    if (model || !run?.id || !activityDay || !preferencesReady) return
    api.get(`/runs/${encodeURIComponent(run.id)}/share-context`, { params: { local_date: activityDay } })
      .then(response => { if (!cancelled) setActivityContext(response.data) })
      .catch(error => {
        if (cancelled) return
        console.warn('[ActivityShareStudio] linked activities unavailable:', error?.message || error)
        setStatus('Linked PRs and same-day lifts could not be loaded. You can still share this run.')
      })
    return () => { cancelled = true }
  }, [model, run?.id, activityDay, preferencesReady])

  const invalidateRender = () => {
    // Invalidate synchronously, including two input/action events in one tick.
    renderPromiseRef.current = null
    renderVersionRef.current += 1
    setRenderReady(false)
  }

  const revokeOwnedPhotoUrl = (url) => {
    if (!url || !ownedPhotoUrlsRef.current.has(url)) return
    URL.revokeObjectURL(url)
    ownedPhotoUrlsRef.current.delete(url)
  }

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => () => {
    photoSelectionVersionRef.current += 1
    for (const url of ownedPhotoUrlsRef.current) URL.revokeObjectURL(url)
    ownedPhotoUrlsRef.current.clear()
  }, [])

  useEffect(() => {
    const body = document.body
    const previousBodyStyle = {
      overflow: body.style.overflow,
      overscrollBehavior: body.style.overscrollBehavior,
      position: body.style.position,
      left: body.style.left,
      top: body.style.top,
      width: body.style.width,
    }
    const scrollX = window.scrollX
    const scrollY = window.scrollY
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null

    body.style.overflow = 'hidden'
    body.style.overscrollBehavior = 'none'
    body.style.position = 'fixed'
    body.style.left = `-${scrollX}px`
    body.style.top = `-${scrollY}px`
    body.style.width = '100%'

    const focusFrame = window.requestAnimationFrame(() => {
      ;(closeButtonRef.current || dialogRef.current)?.focus({ preventScroll: true })
    })
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current?.()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll(MODAL_FOCUSABLE_SELECTOR) || [])
        .filter((element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true')
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current?.focus({ preventScroll: true })
        return
      }
      const activeIndex = focusable.indexOf(document.activeElement)
      const movingBeforeFirst = event.shiftKey && activeIndex <= 0
      const movingAfterLast = !event.shiftKey && (activeIndex === -1 || activeIndex === focusable.length - 1)
      if (!movingBeforeFirst && !movingAfterLast) return
      event.preventDefault()
      focusable[movingBeforeFirst ? focusable.length - 1 : 0].focus({ preventScroll: true })
    }
    document.addEventListener('keydown', handleKeyDown, true)

    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown, true)
      body.style.overflow = previousBodyStyle.overflow
      body.style.overscrollBehavior = previousBodyStyle.overscrollBehavior
      body.style.position = previousBodyStyle.position
      body.style.left = previousBodyStyle.left
      body.style.top = previousBodyStyle.top
      body.style.width = previousBodyStyle.width
      window.scrollTo(scrollX, scrollY)
      previouslyFocused?.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const version = ++renderVersionRef.current
    setRenderReady(false)
    const render = async () => {
      if (!preferencesReady || !TEMPLATES.some(item => item.id === template && item.supports(cardModel))) return null
      let logo = null
      let photo = null
      try {
        logo = await loadImage('/icon-192.png')
      } catch (error) {
        console.error('[ActivityShareStudio] logo load failed:', error?.message || error)
      }
      if (photoUrl) {
        try { photo = await loadImage(photoUrl) }
        catch (error) { throw new Error('Selected photo could not be loaded', { cause: error }) }
      }
      if (cancelled) return null
      // Draw offscreen so a cancelled async render can never overwrite a newer preview.
      const rendered = document.createElement('canvas')
      await drawShareCard(rendered, cardModel, { template, theme, size, photo, logo, showRoute })
      if (cancelled || version !== renderVersionRef.current) return null
      const canvas = canvasRef.current
      if (!canvas) return null
      canvas.width = rendered.width
      canvas.height = rendered.height
      canvas.getContext('2d').drawImage(rendered, 0, 0)
      setRenderReady(true)
      return rendered
    }
    const pending = render()
    renderPromiseRef.current = pending
    pending.catch(error => {
      if (cancelled) return
      console.error('[ActivityShareStudio] render failed:', error?.message || error)
      setStatus('Could not render this share card.')
    })
    return () => { cancelled = true }
  }, [photoUrl, cardModel, template, theme, size, showRoute, preferencesReady])

  const exportCanvas = async () => {
    // Each action uses the exact canvas belonging to its current completed render.
    const canvas = await renderPromiseRef.current
    if (!canvas) throw new Error('Share card is not ready')
    return canvas
  }

  const getFile = async () => {
    const blob = await canvasBlob(await exportCanvas(), fileType, transparent ? undefined : 0.92)
    return new File([blob], filename, { type: fileType })
  }

  const handleShare = () => actionLaneRef.current(async () => {
    setBusy(true)
    setStatus('')
    try {
      const file = await getFile()
      const shareText = caption.trim() ? `${caption.trim()}\n${captionForModel(cardModel)}` : captionForModel(cardModel)
      const shareData = { title: titleForModel(cardModel), text: shareText, files: [file] }
      if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
        await navigator.share(shareData)
      } else {
        const url = URL.createObjectURL(file)
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        link.click()
        URL.revokeObjectURL(url)
        setStatus('Saved to your device.')
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error('[ActivityShareStudio] share failed:', error?.message || error)
        setStatus('Sharing was not available. Try Save instead.')
      }
    } finally {
      setBusy(false)
    }
  })

  const handleSave = () => actionLaneRef.current(async () => {
    setBusy(true)
    setStatus('')
    let url = null
    try {
      const file = await getFile()
      const nativeResult = await PhotoLibraryService.saveImage(file)
      if (nativeResult.saved) {
        setStatus('Saved to Photos.')
        return
      }
      if (nativeResult.requiresNativeUpdate && navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
        setStatus('In the share sheet, choose Save Image to add this card to Photos.')
        await navigator.share({ title: 'Save Forged Hybrid share card', files: [file] })
        return
      }
      url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      setStatus(nativeResult.requiresNativeUpdate ? 'Saved as a download. Direct Photos saving requires the next app build.' : 'Share card saved.')
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error('[ActivityShareStudio] save failed:', error?.message || error)
        setStatus(/photos access/i.test(String(error?.message || '')) ? error.message : 'Could not save this share card.')
      }
    } finally {
      if (url) window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setBusy(false)
    }
  })

  const handleCopy = () => actionLaneRef.current(async () => {
    setBusy(true)
    setStatus('')
    try {
      const blob = await canvasBlob(await exportCanvas())
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        setStatus('Image copied.')
      } else {
        await navigator.clipboard.writeText(captionForModel(cardModel))
        setStatus('Run summary copied.')
      }
    } catch (error) {
      console.error('[ActivityShareStudio] copy failed:', error?.message || error)
      setStatus('Copy was not available on this device.')
    } finally {
      setBusy(false)
    }
  })

  const handlePost = () => actionLaneRef.current(async () => {
    if (!run?.id || cardModel.kind !== 'run') {
      setStatus('Save this run before posting it to friends.')
      return
    }
    setBusy(true)
    setPosted(false)
    setStatus('')
    try {
      const card = cardDataForPost(await exportCanvas(), transparent)
      await api.post('/social/activity-posts', {
        run_id: run.id,
        caption: caption.trim(),
        template,
        card_data: card.data,
        mime_type: card.mimeType,
      })
      setPosted(true)
      setStatus('Posted to your accepted friends in Forged Hybrid.')
    } catch (error) {
      console.error('[ActivityShareStudio] post failed:', error?.message || error)
      setStatus(error?.response?.data?.error || 'Could not post this run right now.')
    } finally {
      setBusy(false)
    }
  })

  const openPhotoPicker = () => {
    const input = fileInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }

  const handlePhoto = async (event) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    const selectionVersion = photoSelectionVersionRef.current + 1
    photoSelectionVersionRef.current = selectionVersion
    const validation = validateActivitySharePhoto(file)
    if (!validation.ok) {
      setPhotoFeedback({ kind: 'error', message: validation.message })
      input.value = ''
      return
    }

    const nextPhotoUrl = URL.createObjectURL(file)
    ownedPhotoUrlsRef.current.add(nextPhotoUrl)
    try {
      await loadImage(nextPhotoUrl)
      if (selectionVersion !== photoSelectionVersionRef.current) {
        revokeOwnedPhotoUrl(nextPhotoUrl)
        return
      }
      if (photoUrl) revokeOwnedPhotoUrl(photoUrl)
      const displayName = String(file.name || 'photo').replace(/[\r\n]+/g, ' ').trim().slice(0, 80) || 'photo'
      setStatus('')
      setPosted(false)
      invalidateRender()
      setPhotoUrl(nextPhotoUrl)
      setPhotoFeedback({ kind: 'selected', message: `Photo selected: ${displayName}.` })
      setTemplate('full-bleed-story')
    } catch (error) {
      revokeOwnedPhotoUrl(nextPhotoUrl)
      if (selectionVersion !== photoSelectionVersionRef.current) return
      console.warn('[ActivityShareStudio] selected photo was not browser-readable:', error?.message || error)
      setPhotoFeedback({ kind: 'error', message: unreadableActivitySharePhotoMessage(file) })
    } finally {
      input.value = ''
    }
  }

  return (
    <div
      className="fixed inset-0 z-[2000] isolate flex items-end justify-center sm:items-center"
      data-testid="share-studio-backdrop"
      style={{ background: 'var(--bg-base)', zIndex: 2000 }}
      onClick={(event) => {
        event.stopPropagation()
        if (event.target === event.currentTarget) onCloseRef.current?.()
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-studio-title"
        tabIndex={-1}
        className="flex max-h-[100dvh] w-full max-w-[480px] flex-col overflow-hidden rounded-t-2xl sm:max-h-[94dvh] sm:rounded-2xl"
        style={{ background: 'var(--bg-card)', boxShadow: '0 18px 60px rgba(0,0,0,0.55)' }}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 px-4 pb-4" style={{ paddingTop: 'max(1rem, env(safe-area-inset-top, 0px))' }}>
          <div>
            <p className="text-xs font-black uppercase" style={{ color: 'var(--accent)', letterSpacing: 1 }}>Forged Hybrid</p>
            <h2 id="share-studio-title" className="mt-1 text-xl font-black" style={{ color: 'var(--text-primary)' }}>Share your {cardModel.kind}</h2>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close share studio" className="pressable grid h-10 w-10 place-items-center rounded-full" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}><X size={20} /></button>
        </header>

        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4"
          data-testid="share-studio-scrollport"
          style={{ WebkitOverflowScrolling: 'touch', paddingBottom: 'max(2rem, env(safe-area-inset-bottom, 0px))' }}
        >

        {activities?.hybrid && <button type="button" disabled={busy} aria-pressed={hybridSelected}
          className="pressable mb-3 min-h-10 rounded-lg px-3 text-sm font-bold"
          onClick={() => { invalidateRender(); setHybridSelected(!hybridSelected); setTemplate(hybridSelected ? null : 'hybrid-split'); setCardTitle(''); setPosted(false); setStatus('') }}>
          {hybridSelected ? 'Share run only' : 'Share run + lift'}
        </button>}

        <div role="radiogroup" aria-label="Share design" className="mb-3 grid grid-cols-3 gap-1 rounded-lg p-1" style={{ background: 'var(--bg-base)' }}>
          {/* Pin an explicit choice even when it is the active fallback. Only a
              different resolved design needs to invalidate the ready render. */}
          {availableTemplates.map((item) => (
            <button key={item.id} type="button" role="radio" aria-checked={template === item.id} tabIndex={template === item.id ? 0 : -1}
              onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const index = availableTemplates.findIndex(entry => entry.id === item.id)
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? availableTemplates.length - 1
                  : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + availableTemplates.length) % availableTemplates.length
                const control = event.currentTarget.parentElement.querySelectorAll('[role="radio"]')[next]
                control.click(); control.focus()
              }} disabled={busy} onClick={() => { setTemplate(item.id); if (template === item.id) return; invalidateRender(); setPosted(false); setStatus('') }} className="pressable min-h-10 rounded-md px-2 text-xs font-bold" style={{ background: template === item.id ? 'var(--accent)' : 'transparent', color: template === item.id ? 'var(--on-accent)' : 'var(--text-muted)' }}>
              {item.label}
            </button>
          ))}
        </div>

        <fieldset disabled={busy} className="mb-3 flex gap-3">
          <legend className="text-xs font-bold">Theme</legend>
          {['light', 'dark', 'color'].map(value => (
            <label key={value} className="flex items-center gap-1 text-sm capitalize">
              <input type="radio" name={`${photoInputId}-theme`} value={value} checked={theme === value} onChange={() => { invalidateRender(); setTheme(value); setPosted(false) }} />{value}
            </label>
          ))}
        </fieldset>
        <fieldset disabled={busy} className="mb-3 flex gap-3">
          <legend className="text-xs font-bold">Size</legend>
          {['feed', 'story'].map(value => (
            <label key={value} className="flex items-center gap-1 text-sm capitalize">
              <input type="radio" name={`${photoInputId}-size`} value={value} checked={size === value} onChange={() => { invalidateRender(); setSize(value); setPosted(false) }} />{value === 'feed' ? 'Feed' : 'Story'}
            </label>
          ))}
        </fieldset>
        <label className="mb-1 flex items-center gap-2 text-sm font-bold">
          <input type="checkbox" checked={showRoute} disabled={busy} onChange={event => { invalidateRender(); setShowRoute(event.target.checked); setPosted(false) }} />
          Show route
        </label>
        <p className="mb-3 text-xs" style={{ color: 'var(--text-muted)' }}>When on, your route is shown as recorded, including its start and finish.</p>

        {!availableTemplates.length && <p role="status" className="mb-3 text-sm">No share templates are available for this activity yet.</p>}
        <div className="relative">
          <canvas ref={canvasRef} width={SIZES[size].w} height={SIZES[size].h} aria-label="Share card preview" aria-busy={!renderReady} className="block w-full rounded-lg object-contain" style={{ aspectRatio: `${SIZES[size].w} / ${SIZES[size].h}`, background: transparent ? 'repeating-conic-gradient(#303033 0% 25%, #202023 0% 50%) 50% / 24px 24px' : '#080808', border: '1px solid var(--border-subtle)' }} />
          {template === 'full-bleed-story' && !photoUrl && (
            <button
              type="button"
              data-testid="photo-canvas-picker"
              aria-label="Add a photo to this share card"
              aria-controls={photoInputId}
              aria-describedby={photoFeedback.message ? photoFeedbackId : undefined}
              onClick={openPhotoPicker}
              className="pressable absolute rounded-xl bg-transparent focus-visible:outline-none focus-visible:ring-4"
              style={{ left: '11.111%', top: size === 'story' ? '28.414%' : '22.222%', width: '77.778%', height: size === 'story' ? '24.63%' : '35.556%', touchAction: 'manipulation', '--tw-ring-color': 'var(--accent)' }}
            >
              <span className="sr-only">Add a photo</span>
            </button>
          )}
        </div>

        {photoFeedback.message && (
          <p
            id={photoFeedbackId}
            role={photoFeedback.kind === 'error' ? 'alert' : 'status'}
            className="mt-2 text-center text-xs font-semibold leading-relaxed"
            style={{ color: photoFeedback.kind === 'error' ? 'var(--danger)' : 'var(--success)' }}
          >
            {photoFeedback.message}
          </p>
        )}

        <p className="mt-2 text-center text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Choose an original Forged card, then post it to accepted friends or share it anywhere.
        </p>

        <label className="mt-3 block text-xs font-bold" style={{ color: 'var(--text-muted)' }}>
          Card title
          <input
            value={cardTitle}
            disabled={busy}
            maxLength={48}
            onChange={(event) => { invalidateRender(); setCardTitle(event.target.value); setPosted(false) }}
            placeholder={titleForModel(cardModel)}
            className="mt-1 block w-full rounded-lg p-3 text-sm"
            style={{ boxSizing: 'border-box', border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
          />
        </label>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1" aria-label="Quote suggestions">
          {FORGED_QUOTES.map((quote) => (
            <button
              key={quote}
              type="button"
              onClick={() => { invalidateRender(); setCardTitle(cardTitle === quote ? '' : quote); setPosted(false) }}
              className="pressable shrink-0 rounded-full px-3 py-1.5 text-xs font-bold"
              style={{ background: cardTitle === quote ? 'var(--accent)' : 'var(--bg-input)', color: cardTitle === quote ? 'var(--on-accent)' : 'var(--text-muted)', border: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}
            >
              {quote}
            </button>
          ))}
        </div>

        <label className="mt-3 block text-xs font-bold" style={{ color: 'var(--text-muted)' }}>
          Caption (optional)
          <textarea value={caption} maxLength={280} rows={2} onChange={(event) => { setCaption(event.target.value); setPosted(false) }} placeholder="What did this run teach you?" className="mt-1 block w-full resize-none rounded-lg p-3 text-sm" style={{ boxSizing: 'border-box', border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} />
        </label>

        <button type="button" onClick={handlePost} disabled={busy || !renderReady || !run?.id || cardModel.kind !== 'run'} className="pressable mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg text-sm font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)', opacity: busy || !run?.id ? 0.55 : 1 }}>
          <Users size={18} /> {busy ? 'Posting…' : 'Post to Forged Hybrid'}
        </button>
        <p className="mt-1 text-center text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>Visible only to you and accepted friends.</p>
        {posted && (
          <button type="button" onClick={() => { onClose(); navigate('/community?tab=activity') }} className="pressable mt-2 min-h-11 w-full rounded-lg text-sm font-bold" style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
            View friend activity
          </button>
        )}

        {usesLegacyPhotoSave && (
          <p className="mt-3 rounded-lg px-3 py-2 text-center text-xs font-semibold leading-relaxed" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
            On this app build, Save opens the iPhone share sheet. Choose Save Image to add the card to Photos.
          </p>
        )}
        <div className="mt-3 grid grid-cols-3 gap-2">
          <button type="button" onClick={handleShare} disabled={busy || !renderReady} className="pressable flex min-h-12 items-center justify-center gap-2 rounded-lg text-sm font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}><Share2 size={17} /> Share</button>
          <button type="button" onClick={handleSave} disabled={busy || !renderReady} className="pressable flex min-h-12 items-center justify-center gap-2 rounded-lg text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}><Download size={17} /> Save</button>
          <button type="button" onClick={handleCopy} disabled={busy || !renderReady} className="pressable flex min-h-12 items-center justify-center gap-2 rounded-lg text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}><Copy size={17} /> Copy</button>
        </div>

        <button
          type="button"
          data-testid="photo-control-picker"
          aria-controls={photoInputId}
          aria-describedby={photoFeedback.message ? photoFeedbackId : undefined}
          onClick={openPhotoPicker}
          className="pressable mt-2 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg text-sm font-bold"
          style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
        >
          <ImagePlus size={17} /> {photoUrl ? 'Change photo' : 'Add a photo'}
        </button>
        {status && <p role="status" className="mt-3 flex items-center justify-center gap-2 text-center text-xs font-semibold" style={{ color: 'var(--text-muted)' }}><Check size={14} style={{ color: 'var(--success)' }} /> {status}</p>}
        </div>
        <input
          ref={fileInputRef}
          id={photoInputId}
          type="file"
          accept="image/*"
          aria-hidden="true"
          tabIndex={-1}
          className="sr-only"
          onChange={handlePhoto}
        />
      </section>
    </div>
  )
}
