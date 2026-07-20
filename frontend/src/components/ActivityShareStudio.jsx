import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download, ImagePlus, Share2, X } from 'lucide-react'
import { parsePlannedRun, parseRunRoute } from '../lib/runRecap'

const CARD_WIDTH = 1080
const CARD_HEIGHT = 1350

const TEMPLATES = [
  { id: 'route', label: 'Route' },
  { id: 'log', label: 'Training Log' },
  { id: 'photo', label: 'Photo' },
]

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Image could not be loaded'))
    image.src = src
  })
}

function formatDuration(secondsValue) {
  const seconds = Math.max(0, Math.round(Number(secondsValue || 0)))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`
}

function formatPace(run) {
  const miles = Number(run?.distance_miles || 0)
  const seconds = Number(run?.duration_seconds || 0)
  if (!(miles > 0) || !(seconds > 0)) return '--'
  const pace = Math.round(seconds / miles)
  return `${Math.floor(pace / 60)}:${String(pace % 60).padStart(2, '0')}/mi`
}

function finiteMetric(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function formatDate(value) {
  const raw = String(value || '')
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00`) : new Date(raw)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function titleForRun(run) {
  const name = String(run?.name || run?.title || '').trim()
  if (name) return name.slice(0, 48)
  const planned = parsePlannedRun(run?.planned_session_json ?? run?.plannedSession)
  const plannedTitle = String(planned?.title || planned?.name || '').trim()
  if (plannedTitle) return plannedTitle.slice(0, 48)
  const stravaTitle = String(run?.notes || '').match(/^Imported from Strava:\s*(.+)$/i)?.[1]?.trim()
  if (stravaTitle) return stravaTitle.slice(0, 48)
  const type = String(run?.type || '').replaceAll('_', ' ').trim()
  if (!type || type === 'easy') return 'Run Complete'
  return `${type.replace(/\b\w/g, (letter) => letter.toUpperCase())} Run`
}

function roundRect(ctx, x, y, width, height, radius, fill, stroke = null) {
  ctx.beginPath()
  ctx.roundRect(x, y, width, height, radius)
  if (fill) {
    ctx.fillStyle = fill
    ctx.fill()
  }
  if (stroke) {
    ctx.strokeStyle = stroke
    ctx.lineWidth = 2
    ctx.stroke()
  }
}

function drawCoverImage(ctx, image, x, y, width, height) {
  const scale = Math.max(width / image.width, height / image.height)
  const drawWidth = image.width * scale
  const drawHeight = image.height * scale
  ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight)
}

function drawBrand(ctx, logo, { dark = true } = {}) {
  if (logo) ctx.drawImage(logo, 72, 62, 78, 78)
  ctx.fillStyle = dark ? '#F5BD02' : '#8A5A00'
  ctx.font = '800 28px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText('FORGED HYBRID', 174, 92)
  ctx.fillStyle = dark ? '#A7A7B0' : '#5E5A51'
  ctx.font = '600 20px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText('Built for the athlete you are becoming', 174, 126)
}

function drawMetric(ctx, label, value, x, y, { dark = true, align = 'left' } = {}) {
  ctx.textAlign = align
  ctx.fillStyle = dark ? '#9CA3AF' : '#625E56'
  ctx.font = '700 20px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(label.toUpperCase(), x, y)
  ctx.fillStyle = dark ? '#FFFFFF' : '#151515'
  ctx.font = '900 42px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(value, x, y + 52)
  ctx.textAlign = 'left'
}

function fitRoute(points, x, y, width, height) {
  if (points.length < 2) return []
  const lats = points.map((point) => point[0])
  const lons = points.map((point) => point[1])
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLon = Math.min(...lons)
  const maxLon = Math.max(...lons)
  const latSpan = Math.max(maxLat - minLat, 0.00001)
  const lonSpan = Math.max(maxLon - minLon, 0.00001)
  const scale = Math.min(width / lonSpan, height / latSpan)
  const routeWidth = lonSpan * scale
  const routeHeight = latSpan * scale
  const left = x + (width - routeWidth) / 2
  const top = y + (height - routeHeight) / 2
  return points.map(([lat, lon]) => [
    left + (lon - minLon) * scale,
    top + (maxLat - lat) * scale,
  ])
}

function drawRoute(ctx, route, bounds) {
  const fitted = fitRoute(route, bounds.x, bounds.y, bounds.width, bounds.height)
  if (fitted.length < 2) {
    ctx.fillStyle = '#71717A'
    ctx.font = '700 28px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('Route was not shared by the recording source', CARD_WIDTH / 2, bounds.y + bounds.height / 2)
    ctx.textAlign = 'left'
    return
  }

  ctx.beginPath()
  fitted.forEach(([pointX, pointY], index) => {
    if (index === 0) ctx.moveTo(pointX, pointY)
    else ctx.lineTo(pointX, pointY)
  })
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#111111'
  ctx.lineWidth = 18
  ctx.stroke()
  ctx.strokeStyle = '#F5BD02'
  ctx.lineWidth = 10
  ctx.stroke()

  const [startX, startY] = fitted[0]
  const [endX, endY] = fitted.at(-1)
  ctx.fillStyle = '#22C55E'
  ctx.beginPath()
  ctx.arc(startX, startY, 16, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#FFFFFF'
  ctx.lineWidth = 5
  ctx.stroke()
  ctx.fillStyle = '#EF4444'
  ctx.beginPath()
  ctx.arc(endX, endY, 16, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
}

function drawRouteTemplate(ctx, run, route, logo) {
  ctx.fillStyle = '#070707'
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  drawBrand(ctx, logo)

  ctx.save()
  ctx.strokeStyle = 'rgba(245,189,2,0.08)'
  ctx.lineWidth = 3
  for (let row = 0; row < 11; row += 1) {
    ctx.beginPath()
    for (let x = -60; x <= CARD_WIDTH + 60; x += 18) {
      const y = 190 + row * 76 + Math.sin((x + row * 41) / 95) * 24
      if (x === -60) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  ctx.restore()

  drawRoute(ctx, route, { x: 92, y: 230, width: 896, height: 650 })
  roundRect(ctx, 60, 930, 960, 330, 30, 'rgba(16,16,18,0.94)', '#2A2A2E')
  ctx.fillStyle = '#FFFFFF'
  ctx.font = '900 52px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(titleForRun(run), 98, 1005)
  ctx.fillStyle = '#A1A1AA'
  ctx.font = '600 24px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(formatDate(run.date || run.created_at), 98, 1046)
  drawMetric(ctx, 'Distance', `${Number(run.distance_miles || 0).toFixed(2)} mi`, 98, 1111)
  drawMetric(ctx, 'Time', formatDuration(run.duration_seconds), 408, 1111)
  drawMetric(ctx, 'Pace', formatPace(run), 708, 1111)
}

function drawLogTemplate(ctx, run, logo) {
  ctx.fillStyle = '#F3EFE4'
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  ctx.strokeStyle = '#D9D1BE'
  ctx.lineWidth = 2
  for (let y = 185; y < CARD_HEIGHT; y += 64) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(CARD_WIDTH, y)
    ctx.stroke()
  }
  ctx.strokeStyle = '#DC8D79'
  ctx.beginPath()
  ctx.moveTo(118, 0)
  ctx.lineTo(118, CARD_HEIGHT)
  ctx.stroke()
  drawBrand(ctx, logo, { dark: false })

  ctx.save()
  ctx.translate(96, 265)
  ctx.rotate(-0.012)
  ctx.fillStyle = '#121212'
  ctx.font = '900 68px Georgia, serif'
  ctx.fillText(titleForRun(run), 0, 0)
  ctx.fillStyle = '#756E62'
  ctx.font = '600 28px Georgia, serif'
  ctx.fillText(formatDate(run.date || run.created_at), 4, 48)
  ctx.restore()

  roundRect(ctx, 78, 360, 924, 304, 20, 'rgba(255,255,255,0.46)', '#CFC6B2')
  drawMetric(ctx, 'Distance', `${Number(run.distance_miles || 0).toFixed(2)} mi`, 120, 435, { dark: false })
  drawMetric(ctx, 'Time', formatDuration(run.duration_seconds), 570, 435, { dark: false })
  drawMetric(ctx, 'Average pace', formatPace(run), 120, 565, { dark: false })
  const averageHeartRate = finiteMetric(run.avg_heart_rate ?? run.avg_hr)
  drawMetric(ctx, 'Average HR', averageHeartRate === null ? '--' : `${Math.round(averageHeartRate)} bpm`, 570, 565, { dark: false })

  ctx.fillStyle = '#A24327'
  ctx.font = 'italic 700 36px Georgia, serif'
  ctx.fillText('THE WORK ADDS UP.', 94, 772)
  ctx.fillStyle = '#1F1F1D'
  ctx.font = '700 32px Georgia, serif'
  const details = [
    `Effort: ${run.perceived_effort ? `${run.perceived_effort}/10` : 'not rated'}`,
    `Elevation: ${finiteMetric(run.elevation_gain) === null ? 'not shared' : `${Math.round(finiteMetric(run.elevation_gain))} ft`}`,
    'Next step: recover, learn, return stronger.',
  ]
  details.forEach((line, index) => ctx.fillText(line, 110, 874 + index * 82))
  ctx.fillStyle = '#8A5A00'
  ctx.font = '900 30px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText('FORGED, NOT FINISHED.', 110, 1216)
}

function drawPhotoTemplate(ctx, run, photo, logo) {
  ctx.fillStyle = '#090909'
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  if (photo) {
    drawCoverImage(ctx, photo, 0, 0, CARD_WIDTH, CARD_HEIGHT)
    const gradient = ctx.createLinearGradient(0, 420, 0, CARD_HEIGHT)
    gradient.addColorStop(0, 'rgba(0,0,0,0.05)')
    gradient.addColorStop(0.72, 'rgba(0,0,0,0.72)')
    gradient.addColorStop(1, 'rgba(0,0,0,0.96)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  } else {
    ctx.fillStyle = '#141417'
    ctx.fillRect(62, 196, 956, 780)
    ctx.strokeStyle = '#34343A'
    ctx.lineWidth = 3
    ctx.setLineDash([18, 14])
    ctx.strokeRect(62, 196, 956, 780)
    ctx.setLineDash([])
    ctx.fillStyle = '#71717A'
    ctx.font = '800 30px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('ADD A PHOTO', CARD_WIDTH / 2, 590)
    ctx.textAlign = 'left'
  }
  drawBrand(ctx, logo)

  ctx.fillStyle = '#FFFFFF'
  ctx.font = '900 62px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(titleForRun(run), 76, 1042)
  ctx.fillStyle = '#D4D4D8'
  ctx.font = '600 25px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(formatDate(run.date || run.created_at), 78, 1086)
  drawMetric(ctx, 'Distance', `${Number(run.distance_miles || 0).toFixed(2)} mi`, 78, 1156)
  drawMetric(ctx, 'Time', formatDuration(run.duration_seconds), 425, 1156)
  drawMetric(ctx, 'Pace', formatPace(run), 740, 1156)
}

function captionForRun(run) {
  return `${titleForRun(run)} · ${Number(run.distance_miles || 0).toFixed(2)} mi · ${formatDuration(run.duration_seconds)} · ${formatPace(run)}\nForged Hybrid`
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Share card could not be created'))
    }, 'image/png')
  })
}

export default function ActivityShareStudio({ run, onClose }) {
  const canvasRef = useRef(null)
  const [template, setTemplate] = useState('route')
  const [photoUrl, setPhotoUrl] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const route = useMemo(() => parseRunRoute(run?.route_coords), [run?.route_coords])
  const filename = `forged-hybrid-run-${String(run?.date || 'activity').replace(/[^0-9a-z-]/gi, '-')}.png`

  useEffect(() => () => {
    if (photoUrl) URL.revokeObjectURL(photoUrl)
  }, [photoUrl])

  useEffect(() => {
    let cancelled = false
    const render = async () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      let logo = null
      let photo = null
      try {
        logo = await loadImage('/icon-192.png')
      } catch (error) {
        console.error('[ActivityShareStudio] logo load failed:', error?.message || error)
      }
      if (photoUrl) {
        try {
          photo = await loadImage(photoUrl)
        } catch (error) {
          console.error('[ActivityShareStudio] photo load failed:', error?.message || error)
        }
      }
      if (cancelled) return
      ctx.clearRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
      if (template === 'log') drawLogTemplate(ctx, run, logo)
      else if (template === 'photo') drawPhotoTemplate(ctx, run, photo, logo)
      else drawRouteTemplate(ctx, run, route, logo)
    }
    render().catch((error) => {
      console.error('[ActivityShareStudio] render failed:', error?.message || error)
      setStatus('Could not render this share card.')
    })
    return () => { cancelled = true }
  }, [photoUrl, route, run, template])

  const getFile = async () => {
    const blob = await canvasBlob(canvasRef.current)
    return new File([blob], filename, { type: 'image/png' })
  }

  const handleShare = async () => {
    setBusy(true)
    setStatus('')
    try {
      const file = await getFile()
      const shareData = { title: titleForRun(run), text: captionForRun(run), files: [file] }
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
  }

  const handleSave = async () => {
    setBusy(true)
    setStatus('')
    let url = null
    try {
      const file = await getFile()
      url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      setStatus('Share card saved.')
    } catch (error) {
      console.error('[ActivityShareStudio] save failed:', error?.message || error)
      setStatus('Could not save this share card.')
    } finally {
      if (url) window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setBusy(false)
    }
  }

  const handleCopy = async () => {
    setBusy(true)
    setStatus('')
    try {
      const blob = await canvasBlob(canvasRef.current)
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        setStatus('Image copied.')
      } else {
        await navigator.clipboard.writeText(captionForRun(run))
        setStatus('Run summary copied.')
      }
    } catch (error) {
      console.error('[ActivityShareStudio] copy failed:', error?.message || error)
      setStatus('Copy was not available on this device.')
    } finally {
      setBusy(false)
    }
  }

  const handlePhoto = (event) => {
    const file = event.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    if (file.size > 15 * 1024 * 1024) {
      setStatus('Choose a photo smaller than 15 MB.')
      event.target.value = ''
      return
    }
    if (photoUrl) URL.revokeObjectURL(photoUrl)
    setStatus('')
    setPhotoUrl(URL.createObjectURL(file))
    setTemplate('photo')
    event.target.value = ''
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.82)' }} onClick={(event) => { event.stopPropagation(); onClose() }}>
      <section className="max-h-[94dvh] w-full max-w-[480px] overflow-y-auto rounded-t-2xl px-4 pb-8 pt-4" style={{ background: 'var(--bg-card)' }} onClick={(event) => event.stopPropagation()} aria-label="Share run">
        <header className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-black uppercase" style={{ color: 'var(--accent)', letterSpacing: 1 }}>Forged Hybrid</p>
            <h2 className="mt-1 text-xl font-black" style={{ color: 'var(--text-primary)' }}>Share your run</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close share studio" className="pressable grid h-10 w-10 place-items-center rounded-full" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}><X size={20} /></button>
        </header>

        <div className="mb-3 grid grid-cols-3 gap-1 rounded-lg p-1" style={{ background: 'var(--bg-base)' }}>
          {TEMPLATES.map((item) => (
            <button key={item.id} type="button" onClick={() => setTemplate(item.id)} className="pressable min-h-10 rounded-md px-2 text-xs font-bold" style={{ background: template === item.id ? 'var(--accent)' : 'transparent', color: template === item.id ? 'var(--on-accent)' : 'var(--text-muted)' }}>
              {item.label}
            </button>
          ))}
        </div>

        <canvas ref={canvasRef} width={CARD_WIDTH} height={CARD_HEIGHT} className="block aspect-[4/5] w-full rounded-lg object-contain" style={{ background: '#080808', border: '1px solid var(--border-subtle)' }} />

        <p className="mt-2 text-center text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Share a Forged card through Messages, Mail, or any social app on your phone.
        </p>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <button type="button" onClick={handleShare} disabled={busy} className="pressable flex min-h-12 items-center justify-center gap-2 rounded-lg text-sm font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}><Share2 size={17} /> Share</button>
          <button type="button" onClick={handleSave} disabled={busy} className="pressable flex min-h-12 items-center justify-center gap-2 rounded-lg text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}><Download size={17} /> Save</button>
          <button type="button" onClick={handleCopy} disabled={busy} className="pressable flex min-h-12 items-center justify-center gap-2 rounded-lg text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}><Copy size={17} /> Copy</button>
        </div>

        <label className="pressable mt-2 flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-lg text-sm font-bold" style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
          <ImagePlus size={17} /> {photoUrl ? 'Change photo' : 'Add a photo'}
          <input type="file" accept="image/*" className="sr-only" onChange={handlePhoto} />
        </label>
        {status && <p role="status" className="mt-3 flex items-center justify-center gap-2 text-center text-xs font-semibold" style={{ color: 'var(--text-muted)' }}><Check size={14} style={{ color: 'var(--success)' }} /> {status}</p>}
      </section>
    </div>
  )
}
