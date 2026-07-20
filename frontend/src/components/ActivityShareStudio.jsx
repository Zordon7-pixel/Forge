import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download, ImagePlus, Share2, Users, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'
import { parsePlannedRun, parseRunRoute } from '../lib/runRecap'

const CARD_WIDTH = 1080
const CARD_HEIGHT = 1350

const TEMPLATES = [
  { id: 'route', label: 'Route' },
  { id: 'log', label: 'Training Log' },
  { id: 'ember', label: 'Ember' },
  { id: 'contour', label: 'Contour' },
  { id: 'overlay', label: 'Overlay' },
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

function drawRoute(ctx, route, bounds, { routeColor = '#F5BD02', outlineColor = '#111111', emptyColor = '#71717A' } = {}) {
  const fitted = fitRoute(route, bounds.x, bounds.y, bounds.width, bounds.height)
  if (fitted.length < 2) {
    ctx.fillStyle = emptyColor
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
  ctx.strokeStyle = outlineColor
  ctx.lineWidth = 18
  ctx.stroke()
  ctx.strokeStyle = routeColor
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

function drawEmberTemplate(ctx, run, logo) {
  const distance = Number(run.distance_miles || 0).toFixed(2)
  ctx.fillStyle = '#080808'
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)

  const ember = ctx.createLinearGradient(0, 160, CARD_WIDTH, 1120)
  ember.addColorStop(0, '#21150A')
  ember.addColorStop(0.52, '#A24327')
  ember.addColorStop(1, '#F5BD02')
  ctx.fillStyle = ember
  ctx.beginPath()
  ctx.moveTo(0, 760)
  ctx.lineTo(CARD_WIDTH, 260)
  ctx.lineTo(CARD_WIDTH, 680)
  ctx.lineTo(0, 1180)
  ctx.closePath()
  ctx.fill()

  drawBrand(ctx, logo)
  ctx.fillStyle = '#FFFFFF'
  ctx.font = '900 58px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(titleForRun(run), 76, 272)
  ctx.fillStyle = '#FDE68A'
  ctx.font = '800 25px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(formatDate(run.date || run.created_at), 78, 318)

  ctx.fillStyle = '#FFFFFF'
  ctx.font = '950 220px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(distance, 66, 710)
  ctx.font = '900 42px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText('MILES', 80, 770)

  roundRect(ctx, 60, 905, 960, 330, 28, 'rgba(5,5,5,0.92)', 'rgba(255,255,255,0.18)')
  drawMetric(ctx, 'Time', formatDuration(run.duration_seconds), 100, 995)
  drawMetric(ctx, 'Pace', formatPace(run), 410, 995)
  const heartRate = finiteMetric(run.avg_heart_rate ?? run.avg_hr)
  drawMetric(ctx, 'Average HR', heartRate === null ? '--' : `${Math.round(heartRate)} bpm`, 720, 995)
  ctx.fillStyle = '#F5BD02'
  ctx.font = '900 28px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText('BANK THE WORK. BUILD THE ATHLETE.', 100, 1180)
}

function drawContourTemplate(ctx, run, route, logo) {
  ctx.fillStyle = '#E9E3D5'
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  ctx.save()
  ctx.strokeStyle = 'rgba(68,64,56,0.16)'
  ctx.lineWidth = 3
  for (let row = 0; row < 15; row += 1) {
    ctx.beginPath()
    for (let x = -50; x <= CARD_WIDTH + 50; x += 16) {
      const y = 160 + row * 72 + Math.sin((x + row * 53) / 82) * 18 + Math.cos(x / 150) * 12
      if (x === -50) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  ctx.restore()
  drawBrand(ctx, logo, { dark: false })
  drawRoute(ctx, route, { x: 86, y: 205, width: 908, height: 690 }, {
    routeColor: '#A24327',
    outlineColor: '#F7F2E8',
    emptyColor: '#625E56',
  })
  roundRect(ctx, 58, 930, 964, 332, 22, 'rgba(247,242,232,0.94)', '#BDB3A0')
  ctx.fillStyle = '#151515'
  ctx.font = '900 52px Georgia, serif'
  ctx.fillText(titleForRun(run), 96, 1008)
  ctx.fillStyle = '#756E62'
  ctx.font = '700 24px Georgia, serif'
  ctx.fillText(formatDate(run.date || run.created_at), 98, 1050)
  drawMetric(ctx, 'Distance', `${Number(run.distance_miles || 0).toFixed(2)} mi`, 98, 1115, { dark: false })
  drawMetric(ctx, 'Time', formatDuration(run.duration_seconds), 406, 1115, { dark: false })
  drawMetric(ctx, 'Pace', formatPace(run), 706, 1115, { dark: false })
}

function drawOverlayTemplate(ctx, run, route, logo) {
  ctx.clearRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  roundRect(ctx, 48, 48, 984, 156, 24, 'rgba(5,5,5,0.82)', 'rgba(255,255,255,0.26)')
  drawBrand(ctx, logo)
  drawRoute(ctx, route, { x: 110, y: 258, width: 860, height: 570 }, {
    routeColor: '#F5BD02',
    outlineColor: 'rgba(0,0,0,0.75)',
    emptyColor: 'rgba(255,255,255,0.86)',
  })
  roundRect(ctx, 48, 890, 984, 398, 30, 'rgba(5,5,5,0.86)', 'rgba(255,255,255,0.28)')
  ctx.fillStyle = '#FFFFFF'
  ctx.font = '900 58px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(titleForRun(run), 92, 980)
  ctx.fillStyle = '#D4D4D8'
  ctx.font = '700 24px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(formatDate(run.date || run.created_at), 94, 1025)
  drawMetric(ctx, 'Distance', `${Number(run.distance_miles || 0).toFixed(2)} mi`, 94, 1100)
  drawMetric(ctx, 'Time', formatDuration(run.duration_seconds), 410, 1100)
  drawMetric(ctx, 'Pace', formatPace(run), 712, 1100)
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

function canvasBlob(canvas, mimeType = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Share card could not be created'))
    }, mimeType, quality)
  })
}

function resizedCanvas(source, width) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = Math.round(width * (CARD_HEIGHT / CARD_WIDTH))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Share card could not be resized')
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

function cardDataForPost(source, transparent) {
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

  ctx.fillStyle = '#F5BD02'
  ctx.font = '900 28px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(String(summary?.eyebrow || 'Hybrid Score').toUpperCase(), 76, 265)
  ctx.fillStyle = '#FFFFFF'
  ctx.font = '950 132px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(String(summary?.primary || '--'), 72, 410)
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
    if (fillWidth > 0) roundRect(ctx, 338, y - 22, fillWidth, 28, 14, metric?.color || '#F5BD02')
    ctx.fillStyle = '#FFFFFF'
    ctx.font = '900 32px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(String(metric?.display || value), 930, y + 4)
    ctx.textAlign = 'left'
  })

  ctx.fillStyle = '#F5BD02'
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

export default function ActivityShareStudio({ run, onClose }) {
  const navigate = useNavigate()
  const canvasRef = useRef(null)
  const [template, setTemplate] = useState('route')
  const [photoUrl, setPhotoUrl] = useState('')
  const [caption, setCaption] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [posted, setPosted] = useState(false)
  const route = useMemo(() => parseRunRoute(run?.route_coords), [run?.route_coords])
  const transparent = template === 'overlay'
  const fileType = transparent ? 'image/png' : 'image/jpeg'
  const fileExtension = transparent ? 'png' : 'jpg'
  const filename = `forged-hybrid-run-${String(run?.date || 'activity').replace(/[^0-9a-z-]/gi, '-')}.${fileExtension}`

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
      else if (template === 'ember') drawEmberTemplate(ctx, run, logo)
      else if (template === 'contour') drawContourTemplate(ctx, run, route, logo)
      else if (template === 'overlay') drawOverlayTemplate(ctx, run, route, logo)
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
    const blob = await canvasBlob(canvasRef.current, fileType, transparent ? undefined : 0.92)
    return new File([blob], filename, { type: fileType })
  }

  const handleShare = async () => {
    setBusy(true)
    setStatus('')
    try {
      const file = await getFile()
      const shareText = caption.trim() ? `${caption.trim()}\n${captionForRun(run)}` : captionForRun(run)
      const shareData = { title: titleForRun(run), text: shareText, files: [file] }
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

  const handlePost = async () => {
    if (!run?.id) {
      setStatus('Save this run before posting it to friends.')
      return
    }
    setBusy(true)
    setPosted(false)
    setStatus('')
    try {
      const card = cardDataForPost(canvasRef.current, transparent)
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
    setPosted(false)
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
            <button key={item.id} type="button" onClick={() => { setTemplate(item.id); setPosted(false); setStatus('') }} className="pressable min-h-10 rounded-md px-2 text-xs font-bold" style={{ background: template === item.id ? 'var(--accent)' : 'transparent', color: template === item.id ? 'var(--on-accent)' : 'var(--text-muted)' }}>
              {item.label}
            </button>
          ))}
        </div>

        <canvas ref={canvasRef} width={CARD_WIDTH} height={CARD_HEIGHT} className="block aspect-[4/5] w-full rounded-lg object-contain" style={{ background: template === 'overlay' ? 'repeating-conic-gradient(#303033 0% 25%, #202023 0% 50%) 50% / 24px 24px' : '#080808', border: '1px solid var(--border-subtle)' }} />

        <p className="mt-2 text-center text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Choose an original Forged card, then post it to accepted friends or share it anywhere.
        </p>

        <label className="mt-3 block text-xs font-bold" style={{ color: 'var(--text-muted)' }}>
          Caption (optional)
          <textarea value={caption} maxLength={280} rows={2} onChange={(event) => { setCaption(event.target.value); setPosted(false) }} placeholder="What did this run teach you?" className="mt-1 block w-full resize-none rounded-lg p-3 text-sm" style={{ boxSizing: 'border-box', border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} />
        </label>

        <button type="button" onClick={handlePost} disabled={busy || !run?.id} className="pressable mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg text-sm font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)', opacity: busy || !run?.id ? 0.55 : 1 }}>
          <Users size={18} /> {busy ? 'Posting…' : 'Post to Forged Hybrid'}
        </button>
        <p className="mt-1 text-center text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>Visible only to you and accepted friends.</p>
        {posted && (
          <button type="button" onClick={() => { onClose(); navigate('/community?tab=activity') }} className="pressable mt-2 min-h-11 w-full rounded-lg text-sm font-bold" style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
            View friend activity
          </button>
        )}

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
