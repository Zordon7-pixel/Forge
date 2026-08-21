import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download, ImagePlus, Share2, Users, X } from 'lucide-react'
import { useNavigate } from 'react-router'
import api from '../lib/api'
import { createActionSingleFlight } from '../lib/actionSingleFlight'
import { unreadableActivitySharePhotoMessage, validateActivitySharePhoto } from '../lib/activitySharePhoto'
import { parsePlannedRun, parseRunRoute, parseZoneTimeline } from '../lib/runRecap'
import PhotoLibraryService from '../services/PhotoLibraryService'

const CARD_WIDTH = 1080
const CARD_HEIGHT = 1350
const ROUTE_START_COLOR = '#22C55E'
const ROUTE_END_COLOR = '#EF4444'
const MODAL_FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

const TEMPLATES = [
  { id: 'route', label: 'Route' },
  { id: 'log', label: 'Training Log' },
  { id: 'ember', label: 'Ember' },
  { id: 'contour', label: 'Contour' },
  { id: 'overlay', label: 'Overlay' },
  { id: 'photo', label: 'Photo' },
]

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

// Tempered Steel & Ember share-card palette — hex required: canvas API, no CSS vars
const CARD_FONT = '-apple-system, BlinkMacSystemFont, sans-serif'
const CARD_GOLD = '#EAB308'
const CARD_EMBER = '#F97316'
const CARD_HOT = '#FFF6DC'
const CARD_COAL = '#0C0A07'
const CARD_STEEL = '#16130D'
const CARD_ZONES = [
  { key: 'Z1', color: '#5E6C7B' },
  { key: 'Z2', color: '#EAB308' },
  { key: 'Z3', color: '#F97316' },
  { key: 'Z4', color: '#E5484D' },
  { key: 'Z5', color: '#FFF6DC' },
]

function mulberry32(seed) {
  let a = seed | 0
  return function next() {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function emberGradient(ctx, x0, y0, x1, y1) {
  const gradient = ctx.createLinearGradient(x0, y0, x1, y1)
  gradient.addColorStop(0, CARD_GOLD)
  gradient.addColorStop(1, CARD_EMBER)
  return gradient
}

function drawTracked(ctx, text, x, y, letterSpacing) {
  let cursor = x
  for (const char of String(text)) {
    ctx.fillText(char, cursor, y)
    cursor += ctx.measureText(char).width + letterSpacing
  }
  return cursor - letterSpacing
}

function drawMicro(ctx, text, x, y, color) {
  ctx.fillStyle = color
  ctx.font = `800 22px ${CARD_FONT}`
  drawTracked(ctx, String(text).toUpperCase(), x, y, 5)
}

function drawBrand(ctx, logo, { dark = true, x = 72, y = 64 } = {}) {
  if (logo) {
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(x, y, 64, 64, 16)
    ctx.clip()
    ctx.drawImage(logo, x, y, 64, 64)
    ctx.restore()
  }
  ctx.fillStyle = dark ? CARD_HOT : '#1C1812'
  ctx.font = `900 30px ${CARD_FONT}`
  drawTracked(ctx, 'FORGED HYBRID', x + 86, y + 40, 7)
  ctx.fillStyle = emberGradient(ctx, x + 86, 0, x + 326, 0)
  ctx.fillRect(x + 86, y + 52, 118, 4)
}

function drawStatRow(ctx, items, x, y, gap, { dark = true, valueSize = 58 } = {}) {
  let cursor = x
  items.forEach(([label, value, width], index) => {
    if (index > 0) {
      ctx.fillStyle = dark ? 'rgba(255,246,220,0.14)' : 'rgba(28,24,18,0.18)'
      ctx.fillRect(cursor - gap / 2, y - 46, 2, 86)
    }
    ctx.fillStyle = dark ? '#8E877A' : '#6E6656'
    ctx.font = `800 21px ${CARD_FONT}`
    drawTracked(ctx, label.toUpperCase(), cursor, y, 4)
    ctx.fillStyle = dark ? '#FFFFFF' : '#151210'
    ctx.font = `900 ${valueSize}px ${CARD_FONT}`
    ctx.fillText(value, cursor, y + 62)
    cursor += width + gap
  })
}

function trustedZoneMinutes(run) {
  const timeline = parseZoneTimeline(run?.heart_rate_zones, run?.duration_seconds)
  if (!timeline.trusted || !(timeline.totalSeconds > 0)) return null
  const minutes = timeline.seconds.map((seconds) => Math.round(seconds / 60))
  return minutes.some((minute) => minute > 0) ? minutes : null
}

function drawZoneBar(ctx, minutes, x, y, width, { dark = true } = {}) {
  const total = minutes.reduce((sum, minute) => sum + minute, 0)
  if (!(total > 0)) return
  const gap = 6
  const barHeight = 34
  let cursor = x
  minutes.forEach((minute, index) => {
    const segmentWidth = Math.max(10, (width - gap * 4) * (minute / total))
    if (index === 4) {
      ctx.save()
      ctx.shadowColor = CARD_HOT
      ctx.shadowBlur = 22
    }
    roundRect(ctx, cursor, y, segmentWidth, barHeight, 8, CARD_ZONES[index].color)
    if (index === 4) ctx.restore()
    ctx.fillStyle = dark ? '#8E877A' : '#6E6656'
    ctx.font = `800 20px ${CARD_FONT}`
    ctx.fillText(CARD_ZONES[index].key, cursor, y - 14)
    ctx.fillStyle = dark ? '#5B5648' : '#8A8272'
    ctx.font = `700 19px ${CARD_FONT}`
    ctx.fillText(`${minute}m`, cursor, y + barHeight + 28)
    cursor += segmentWidth + gap
  })
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

function drawRoute(ctx, route, bounds, { casing = '#1A150C', glow = CARD_EMBER, gradient = true, routeColor = CARD_GOLD, lineWidth = 11, emptyColor = '#71717A' } = {}) {
  const fitted = fitRoute(route, bounds.x, bounds.y, bounds.width, bounds.height)
  if (fitted.length < 2) {
    ctx.fillStyle = emptyColor
    ctx.font = `700 28px ${CARD_FONT}`
    ctx.textAlign = 'center'
    ctx.fillText('Route was not shared by the recording source', CARD_WIDTH / 2, bounds.y + bounds.height / 2)
    ctx.textAlign = 'left'
    return
  }

  const trace = () => {
    ctx.beginPath()
    fitted.forEach(([pointX, pointY], index) => {
      if (index === 0) ctx.moveTo(pointX, pointY)
      else ctx.lineTo(pointX, pointY)
    })
  }
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.save()
  ctx.shadowColor = glow
  ctx.shadowBlur = 46
  trace()
  ctx.strokeStyle = 'rgba(249,115,22,0.42)'
  ctx.lineWidth = lineWidth + 8
  ctx.stroke()
  ctx.restore()
  trace()
  ctx.strokeStyle = casing
  ctx.lineWidth = lineWidth + 11
  ctx.stroke()
  trace()
  if (gradient) {
    const xs = fitted.map((point) => point[0])
    const ys = fitted.map((point) => point[1])
    ctx.strokeStyle = emberGradient(ctx, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))
  } else {
    ctx.strokeStyle = routeColor
  }
  ctx.lineWidth = lineWidth
  ctx.stroke()

  const [startX, startY] = fitted[0]
  const [endX, endY] = fitted.at(-1)
  ctx.fillStyle = ROUTE_START_COLOR
  ctx.beginPath()
  ctx.arc(startX, startY, 13, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = casing
  ctx.lineWidth = 5
  ctx.stroke()
  ctx.save()
  ctx.shadowColor = ROUTE_END_COLOR
  ctx.shadowBlur = 30
  ctx.fillStyle = ROUTE_END_COLOR
  ctx.beginPath()
  ctx.arc(endX, endY, 15, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  ctx.strokeStyle = casing
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.arc(endX, endY, 15, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

function drawRouteTemplate(ctx, run, route, logo) {
  const ground = ctx.createRadialGradient(CARD_WIDTH / 2, 470, 120, CARD_WIDTH / 2, 600, 900)
  ground.addColorStop(0, '#171208')
  ground.addColorStop(0.55, CARD_COAL)
  ground.addColorStop(1, '#070503')
  ctx.fillStyle = ground
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  ctx.strokeStyle = 'rgba(255,246,220,0.035)'
  ctx.lineWidth = 1
  for (let x = 90; x < CARD_WIDTH; x += 100) {
    ctx.beginPath()
    ctx.moveTo(x, 180)
    ctx.lineTo(x, 905)
    ctx.stroke()
  }
  for (let y = 230; y < 910; y += 100) {
    ctx.beginPath()
    ctx.moveTo(60, y)
    ctx.lineTo(CARD_WIDTH - 60, y)
    ctx.stroke()
  }
  drawBrand(ctx, logo)
  drawRoute(ctx, route, { x: 140, y: 250, width: 800, height: 600 })
  ctx.fillStyle = '#FFFFFF'
  ctx.font = `900 58px ${CARD_FONT}`
  ctx.fillText(titleForRun(run), 72, 985)
  drawMicro(ctx, formatDate(run.date || run.created_at), 74, 1026, '#8E877A')
  const distance = Number(run.distance_miles || 0).toFixed(2)
  ctx.fillStyle = '#FFFFFF'
  ctx.font = `900 148px ${CARD_FONT}`
  ctx.fillText(distance, 66, 1210)
  const distanceWidth = ctx.measureText(distance).width
  ctx.fillStyle = CARD_GOLD
  ctx.font = `900 40px ${CARD_FONT}`
  ctx.fillText('MI', 84 + distanceWidth, 1210)
  const heartRate = finiteMetric(run.avg_heart_rate ?? run.avg_hr)
  drawStatRow(ctx, [
    ['Time', formatDuration(run.duration_seconds), 148],
    ['Pace', formatPace(run), 192],
    ['Avg HR', heartRate === null ? '--' : `${Math.round(heartRate)}`, 90],
  ], 500, 1122, 42, { valueSize: 44 })
}

function drawLogTemplate(ctx, run, logo) {
  ctx.fillStyle = '#0A0806'
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  roundRect(ctx, 44, 44, CARD_WIDTH - 88, CARD_HEIGHT - 88, 34, CARD_STEEL)
  const rand = mulberry32(7)
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(44, 44, CARD_WIDTH - 88, CARD_HEIGHT - 88, 34)
  ctx.clip()
  for (let x = 44; x < CARD_WIDTH - 44; x += 3) {
    ctx.fillStyle = `rgba(255,246,220,${0.004 + rand() * 0.014})`
    ctx.fillRect(x, 44, 1, CARD_HEIGHT - 88)
  }
  ctx.restore()
  roundRect(ctx, 44, 44, CARD_WIDTH - 88, CARD_HEIGHT - 88, 34, null, 'rgba(255,246,220,0.10)')
  roundRect(ctx, 60, 60, CARD_WIDTH - 120, CARD_HEIGHT - 120, 26, null, 'rgba(0,0,0,0.55)')
  ;[[92, 92], [CARD_WIDTH - 92, 92], [92, CARD_HEIGHT - 92], [CARD_WIDTH - 92, CARD_HEIGHT - 92]].forEach(([x, y]) => {
    ctx.fillStyle = '#0E0B07'
    ctx.beginPath()
    ctx.arc(x, y, 13, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,246,220,0.22)'
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.arc(x, y, 13, Math.PI * 0.8, Math.PI * 1.7)
    ctx.stroke()
  })
  drawBrand(ctx, logo, { x: 110, y: 104 })
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.95)'
  ctx.shadowOffsetY = 3
  ctx.fillStyle = '#B9AE93'
  ctx.font = `900 33px ${CARD_FONT}`
  drawTracked(ctx, 'TRAINING LOG', 110, 268, 13)
  ctx.restore()
  const serial = String(run.date || run.created_at || '').slice(0, 10).replace(/-/g, '') || '00000000'
  ctx.fillStyle = '#5B5648'
  ctx.font = '800 26px ui-monospace, Menlo, monospace'
  ctx.textAlign = 'right'
  ctx.fillText(`Nº ${serial}`, CARD_WIDTH - 110, 268)
  ctx.textAlign = 'left'
  ctx.fillStyle = 'rgba(255,246,220,0.10)'
  ctx.fillRect(110, 296, CARD_WIDTH - 220, 2)
  ctx.fillStyle = '#FFFFFF'
  ctx.font = `900 68px ${CARD_FONT}`
  ctx.fillText(titleForRun(run), 108, 392)
  drawMicro(ctx, formatDate(run.date || run.created_at), 110, 436, '#8E877A')
  const heartRate = finiteMetric(run.avg_heart_rate ?? run.avg_hr)
  const elevation = finiteMetric(run.elevation_gain)
  const rows = [
    ['DISTANCE', `${Number(run.distance_miles || 0).toFixed(2)} MI`],
    ['TIME', formatDuration(run.duration_seconds)],
    ['PACE', formatPace(run).toUpperCase()],
    ['AVG HEART RATE', heartRate === null ? '--' : `${Math.round(heartRate)} BPM`],
    ['ELEVATION', elevation === null ? 'NOT SHARED' : `${Math.round(elevation)} FT`],
    ['EFFORT', run.perceived_effort ? `${run.perceived_effort} / 10` : 'NOT RATED'],
  ]
  rows.forEach((row, index) => {
    const y = 560 + index * 104
    ctx.fillStyle = '#8E877A'
    ctx.font = `800 26px ${CARD_FONT}`
    const labelEnd = drawTracked(ctx, row[0], 110, y, 4)
    ctx.fillStyle = '#FFFFFF'
    ctx.font = `900 46px ${CARD_FONT}`
    ctx.textAlign = 'right'
    ctx.fillText(row[1], CARD_WIDTH - 110, y + 2)
    const valueWidth = ctx.measureText(row[1]).width
    ctx.textAlign = 'left'
    ctx.fillStyle = 'rgba(255,246,220,0.16)'
    for (let dotX = labelEnd + 26; dotX < CARD_WIDTH - 130 - valueWidth; dotX += 16) ctx.fillRect(dotX, y - 6, 4, 4)
    if (index < rows.length - 1) {
      ctx.fillStyle = 'rgba(255,246,220,0.05)'
      ctx.fillRect(110, y + 46, CARD_WIDTH - 220, 1)
    }
  })
  ctx.save()
  ctx.translate(CARD_WIDTH - 330, 1216)
  ctx.rotate(-0.075)
  ctx.strokeStyle = 'rgba(234,179,8,0.85)'
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.roundRect(-10, -46, 232, 72, 10)
  ctx.stroke()
  ctx.fillStyle = 'rgba(234,179,8,0.9)'
  ctx.font = `900 40px ${CARD_FONT}`
  drawTracked(ctx, 'FORGED', 22, 6, 8)
  ctx.restore()
  ctx.fillStyle = CARD_GOLD
  ctx.font = `900 26px ${CARD_FONT}`
  drawTracked(ctx, 'THE WORK ADDS UP.', 110, 1228, 6)
}

function drawEmberTemplate(ctx, run, logo) {
  ctx.fillStyle = '#070503'
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  const heat = ctx.createLinearGradient(0, 640, 0, CARD_HEIGHT)
  heat.addColorStop(0, 'rgba(122,46,18,0)')
  heat.addColorStop(0.42, 'rgba(160,58,16,0.55)')
  heat.addColorStop(0.78, 'rgba(249,115,22,0.82)')
  heat.addColorStop(1, 'rgba(234,179,8,0.95)')
  ctx.fillStyle = heat
  ctx.fillRect(0, 640, CARD_WIDTH, CARD_HEIGHT - 640)
  const core = ctx.createRadialGradient(CARD_WIDTH / 2, CARD_HEIGHT + 140, 60, CARD_WIDTH / 2, CARD_HEIGHT + 140, 760)
  core.addColorStop(0, 'rgba(255,246,220,0.85)')
  core.addColorStop(0.4, 'rgba(249,115,22,0.35)')
  core.addColorStop(1, 'rgba(249,115,22,0)')
  ctx.fillStyle = core
  ctx.fillRect(0, 560, CARD_WIDTH, CARD_HEIGHT - 560)
  const rand = mulberry32(42)
  for (let i = 0; i < 64; i += 1) {
    const x = rand() * CARD_WIDTH
    const y = 660 + rand() * 640
    const radius = 1.5 + rand() * 4
    const alpha = 0.18 + rand() * 0.6
    ctx.save()
    ctx.shadowColor = rand() > 0.5 ? CARD_GOLD : CARD_HOT
    ctx.shadowBlur = 14
    ctx.fillStyle = `rgba(255,${200 + Math.floor(rand() * 55)},140,${alpha})`
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  drawBrand(ctx, logo)
  ctx.fillStyle = '#FFFFFF'
  ctx.font = `900 56px ${CARD_FONT}`
  ctx.fillText(titleForRun(run), 72, 258)
  drawMicro(ctx, formatDate(run.date || run.created_at), 74, 300, '#8E877A')
  ctx.save()
  ctx.shadowColor = 'rgba(255,246,220,0.55)'
  ctx.shadowBlur = 42
  const distanceGradient = ctx.createLinearGradient(0, 380, 0, 660)
  distanceGradient.addColorStop(0, '#FFFFFF')
  distanceGradient.addColorStop(1, CARD_HOT)
  ctx.fillStyle = distanceGradient
  ctx.font = `900 252px ${CARD_FONT}`
  ctx.fillText(Number(run.distance_miles || 0).toFixed(2), 52, 646)
  ctx.restore()
  ctx.fillStyle = CARD_GOLD
  ctx.font = `900 44px ${CARD_FONT}`
  drawTracked(ctx, 'MILES', 66, 712, 12)
  roundRect(ctx, 60, 880, CARD_WIDTH - 120, 336, 28, 'rgba(7,5,3,0.88)', 'rgba(255,246,220,0.16)')
  const heartRate = finiteMetric(run.avg_heart_rate ?? run.avg_hr)
  const zoneMinutes = trustedZoneMinutes(run)
  const statY = zoneMinutes ? 968 : 1020
  drawStatRow(ctx, [
    ['Time', formatDuration(run.duration_seconds), 250],
    ['Pace', formatPace(run), 268],
    ['Avg HR', heartRate === null ? '--' : `${Math.round(heartRate)} bpm`, 210],
  ], 118, statY, 52)
  if (zoneMinutes) drawZoneBar(ctx, zoneMinutes, 118, 1094, CARD_WIDTH - 236)
  ctx.fillStyle = CARD_HOT
  ctx.font = `900 27px ${CARD_FONT}`
  drawTracked(ctx, 'EFFORT IS HEAT.', 66, 1292, 7)
}

function drawContourTemplate(ctx, run, route, logo) {
  ctx.fillStyle = '#EFE9DB'
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  const centerX = CARD_WIDTH / 2
  const centerY = 545
  ctx.strokeStyle = 'rgba(90,80,60,0.12)'
  ctx.lineWidth = 2
  for (let ring = 70; ring <= 760; ring += 46) {
    ctx.beginPath()
    for (let angle = 0; angle <= Math.PI * 2 + 0.05; angle += 0.04) {
      const radius = ring * (1 + 0.09 * Math.sin(3 * angle + ring * 0.02) + 0.05 * Math.cos(5 * angle - ring * 0.013))
      const pointX = centerX + radius * Math.cos(angle) * 1.12
      const pointY = centerY + radius * Math.sin(angle) * 0.8
      if (angle === 0) ctx.moveTo(pointX, pointY)
      else ctx.lineTo(pointX, pointY)
    }
    ctx.stroke()
  }
  const fade = ctx.createLinearGradient(0, 760, 0, 980)
  fade.addColorStop(0, 'rgba(239,233,219,0)')
  fade.addColorStop(1, '#EFE9DB')
  ctx.fillStyle = fade
  ctx.fillRect(0, 760, CARD_WIDTH, 240)
  drawBrand(ctx, logo, { dark: false })
  drawRoute(ctx, route, { x: 170, y: 240, width: 740, height: 560 }, {
    casing: '#F7F2E6',
    glow: 'rgba(184,74,23,0.55)',
    gradient: false,
    routeColor: '#B84A17',
    lineWidth: 12,
    emptyColor: '#625E56',
  })
  ctx.fillStyle = '#151210'
  ctx.font = '900 74px Georgia, serif'
  ctx.fillText(titleForRun(run), 96, 1015)
  ctx.fillStyle = emberGradient(ctx, 96, 0, 356, 0)
  ctx.fillRect(98, 1042, 190, 5)
  ctx.fillStyle = '#8A8272'
  ctx.font = '700 25px Georgia, serif'
  ctx.fillText(formatDate(run.date || run.created_at), 98, 1092)
  ctx.fillStyle = 'rgba(28,24,18,0.16)'
  ctx.fillRect(96, 1122, CARD_WIDTH - 192, 2)
  const values = [
    ['Distance', `${Number(run.distance_miles || 0).toFixed(2)} mi`],
    ['Time', formatDuration(run.duration_seconds)],
    ['Pace', formatPace(run)],
  ]
  values.forEach(([label, value], index) => {
    const x = 98 + index * 310
    ctx.fillStyle = '#8A8272'
    ctx.font = `800 21px ${CARD_FONT}`
    drawTracked(ctx, label.toUpperCase(), x, 1176, 4)
    ctx.fillStyle = '#1C1812'
    ctx.font = '900 52px Georgia, serif'
    ctx.fillText(value, x, 1244)
  })
}

function drawOverlayTemplate(ctx, run, route, logo) {
  ctx.clearRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  roundRect(ctx, 64, 64, 438, 104, 999, 'rgba(7,5,3,0.78)', 'rgba(255,246,220,0.22)')
  if (logo) {
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(82, 80, 72, 72, 999)
    ctx.clip()
    ctx.drawImage(logo, 82, 80, 72, 72)
    ctx.restore()
  }
  ctx.fillStyle = CARD_HOT
  ctx.font = `900 27px ${CARD_FONT}`
  drawTracked(ctx, 'FORGED HYBRID', 172, 130, 5)
  drawRoute(ctx, route, { x: CARD_WIDTH - 372, y: 236, width: 300, height: 300 }, {
    casing: 'rgba(0,0,0,0.7)',
    lineWidth: 9,
    emptyColor: 'rgba(255,255,255,0.86)',
  })
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.8)'
  ctx.shadowBlur = 26
  ctx.shadowOffsetY = 4
  ctx.fillStyle = emberGradient(ctx, 72, 0, 72, CARD_HEIGHT)
  ctx.fillRect(72, 842, 7, 392)
  ctx.fillStyle = '#FFFFFF'
  ctx.font = `900 56px ${CARD_FONT}`
  ctx.fillText(titleForRun(run), 118, 900)
  ctx.fillStyle = 'rgba(255,255,255,0.82)'
  ctx.font = `800 24px ${CARD_FONT}`
  drawTracked(ctx, formatDate(run.date || run.created_at).toUpperCase(), 120, 944, 5)
  ctx.fillStyle = '#FFFFFF'
  ctx.font = `900 104px ${CARD_FONT}`
  ctx.fillText(`${Number(run.distance_miles || 0).toFixed(2)} MI`, 114, 1066)
  ctx.font = `900 74px ${CARD_FONT}`
  const timeText = formatDuration(run.duration_seconds)
  ctx.fillText(timeText, 114, 1168)
  const timeWidth = ctx.measureText(timeText).width
  ctx.fillStyle = CARD_HOT
  ctx.font = `900 46px ${CARD_FONT}`
  ctx.fillText(formatPace(run), 132 + timeWidth, 1160)
  ctx.restore()
}

function drawPhotoTemplate(ctx, run, photo, logo) {
  ctx.fillStyle = '#070503'
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  if (photo) {
    drawCoverImage(ctx, photo, 0, 0, CARD_WIDTH, CARD_HEIGHT)
    ctx.fillStyle = 'rgba(234,179,8,0.05)'
    ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
    const gradient = ctx.createLinearGradient(0, CARD_HEIGHT - 720, 0, CARD_HEIGHT - 300)
    gradient.addColorStop(0, 'rgba(7,5,3,0)')
    gradient.addColorStop(1, 'rgba(7,5,3,0.72)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, CARD_HEIGHT - 720, CARD_WIDTH, 420)
  } else {
    const rand = mulberry32(11)
    for (let i = 0; i < 26; i += 1) {
      const x = rand() * CARD_WIDTH
      const y = rand() * 880
      const radius = 1 + rand() * 2.5
      ctx.fillStyle = `rgba(255,246,220,${0.05 + rand() * 0.12})`
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.fill()
    }
    roundRect(ctx, 120, 300, CARD_WIDTH - 240, 480, 28, 'rgba(255,246,220,0.03)', 'rgba(255,246,220,0.14)')
    ctx.strokeStyle = 'rgba(255,246,220,0.3)'
    ctx.lineWidth = 6
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(CARD_WIDTH / 2 - 44, 516)
    ctx.lineTo(CARD_WIDTH / 2 + 44, 516)
    ctx.moveTo(CARD_WIDTH / 2, 472)
    ctx.lineTo(CARD_WIDTH / 2, 560)
    ctx.stroke()
    ctx.fillStyle = '#8E877A'
    ctx.font = `900 30px ${CARD_FONT}`
    ctx.textAlign = 'center'
    ctx.fillText('A D D   A   P H O T O', CARD_WIDTH / 2, 640)
    ctx.fillStyle = '#5B5648'
    ctx.font = `700 24px ${CARD_FONT}`
    ctx.fillText('It becomes the whole card', CARD_WIDTH / 2, 684)
    ctx.textAlign = 'left'
  }
  drawBrand(ctx, logo)
  ctx.fillStyle = emberGradient(ctx, 0, 0, CARD_WIDTH, 0)
  ctx.fillRect(0, CARD_HEIGHT - 330, CARD_WIDTH, 6)
  ctx.fillStyle = 'rgba(7,5,3,0.96)'
  ctx.fillRect(0, CARD_HEIGHT - 324, CARD_WIDTH, 324)
  ctx.fillStyle = '#FFFFFF'
  ctx.font = `900 54px ${CARD_FONT}`
  ctx.fillText(titleForRun(run), 72, CARD_HEIGHT - 234)
  drawMicro(ctx, formatDate(run.date || run.created_at), 74, CARD_HEIGHT - 192, '#8E877A')
  drawStatRow(ctx, [
    ['Distance', `${Number(run.distance_miles || 0).toFixed(2)} mi`, 300],
    ['Time', formatDuration(run.duration_seconds), 250],
    ['Pace', formatPace(run), 240],
  ], 74, CARD_HEIGHT - 108, 56)
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

  ctx.fillStyle = '#EAB308'
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
  const [template, setTemplate] = useState('route')
  const [photoUrl, setPhotoUrl] = useState('')
  const [photoFeedback, setPhotoFeedback] = useState({ kind: '', message: '' })
  const [caption, setCaption] = useState('')
  const [cardTitle, setCardTitle] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [posted, setPosted] = useState(false)
  const route = useMemo(() => parseRunRoute(run?.route_coords), [run?.route_coords])
  // Custom headline (edited title or picked quote) flows through titleForRun
  // via the name field — cards, share text, and posts all stay in sync.
  const cardRun = useMemo(() => {
    const custom = cardTitle.trim()
    return custom ? { ...run, name: custom } : run
  }, [run, cardTitle])
  const transparent = template === 'overlay'
  const fileType = transparent ? 'image/png' : 'image/jpeg'
  const fileExtension = transparent ? 'png' : 'jpg'
  const filename = `forged-hybrid-run-${String(run?.date || 'activity').replace(/[^0-9a-z-]/gi, '-')}.${fileExtension}`
  const usesLegacyPhotoSave = PhotoLibraryService.isNativeRuntime() && !PhotoLibraryService.isDirectSaveAvailable()

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
      if (template === 'log') drawLogTemplate(ctx, cardRun, logo)
      else if (template === 'ember') drawEmberTemplate(ctx, cardRun, logo)
      else if (template === 'contour') drawContourTemplate(ctx, cardRun, route, logo)
      else if (template === 'overlay') drawOverlayTemplate(ctx, cardRun, route, logo)
      else if (template === 'photo') drawPhotoTemplate(ctx, cardRun, photo, logo)
      else drawRouteTemplate(ctx, cardRun, route, logo)
    }
    render().catch((error) => {
      console.error('[ActivityShareStudio] render failed:', error?.message || error)
      setStatus('Could not render this share card.')
    })
    return () => { cancelled = true }
  }, [photoUrl, route, cardRun, template])

  const getFile = async () => {
    const blob = await canvasBlob(canvasRef.current, fileType, transparent ? undefined : 0.92)
    return new File([blob], filename, { type: fileType })
  }

  const handleShare = () => actionLaneRef.current(async () => {
    setBusy(true)
    setStatus('')
    try {
      const file = await getFile()
      const shareText = caption.trim() ? `${caption.trim()}\n${captionForRun(cardRun)}` : captionForRun(cardRun)
      const shareData = { title: titleForRun(cardRun), text: shareText, files: [file] }
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
      const blob = await canvasBlob(canvasRef.current)
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        setStatus('Image copied.')
      } else {
        await navigator.clipboard.writeText(captionForRun(cardRun))
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
      setPhotoUrl(nextPhotoUrl)
      setPhotoFeedback({ kind: 'selected', message: `Photo selected: ${displayName}.` })
      setTemplate('photo')
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
            <h2 id="share-studio-title" className="mt-1 text-xl font-black" style={{ color: 'var(--text-primary)' }}>Share your run</h2>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close share studio" className="pressable grid h-10 w-10 place-items-center rounded-full" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}><X size={20} /></button>
        </header>

        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4"
          data-testid="share-studio-scrollport"
          style={{ WebkitOverflowScrolling: 'touch', paddingBottom: 'max(2rem, env(safe-area-inset-bottom, 0px))' }}
        >

        <div className="mb-3 grid grid-cols-3 gap-1 rounded-lg p-1" style={{ background: 'var(--bg-base)' }}>
          {TEMPLATES.map((item) => (
            <button key={item.id} type="button" onClick={() => { setTemplate(item.id); setPosted(false); setStatus('') }} className="pressable min-h-10 rounded-md px-2 text-xs font-bold" style={{ background: template === item.id ? 'var(--accent)' : 'transparent', color: template === item.id ? 'var(--on-accent)' : 'var(--text-muted)' }}>
              {item.label}
            </button>
          ))}
        </div>

        <div className="relative">
          <canvas ref={canvasRef} width={CARD_WIDTH} height={CARD_HEIGHT} className="block aspect-[4/5] w-full rounded-lg object-contain" style={{ background: template === 'overlay' ? 'repeating-conic-gradient(#303033 0% 25%, #202023 0% 50%) 50% / 24px 24px' : '#080808', border: '1px solid var(--border-subtle)' }} />
          {template === 'photo' && !photoUrl && (
            <button
              type="button"
              data-testid="photo-canvas-picker"
              aria-label="Add a photo to this share card"
              aria-controls={photoInputId}
              aria-describedby={photoFeedback.message ? photoFeedbackId : undefined}
              onClick={openPhotoPicker}
              className="pressable absolute rounded-xl bg-transparent focus-visible:outline-none focus-visible:ring-4"
              style={{ left: '11.111%', top: '22.222%', width: '77.778%', height: '35.556%', touchAction: 'manipulation', '--tw-ring-color': 'var(--accent)' }}
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
            maxLength={48}
            onChange={(event) => { setCardTitle(event.target.value); setPosted(false) }}
            placeholder={titleForRun(run)}
            className="mt-1 block w-full rounded-lg p-3 text-sm"
            style={{ boxSizing: 'border-box', border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
          />
        </label>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1" aria-label="Quote suggestions">
          {FORGED_QUOTES.map((quote) => (
            <button
              key={quote}
              type="button"
              onClick={() => { setCardTitle(cardTitle === quote ? '' : quote); setPosted(false) }}
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

        <button type="button" onClick={handlePost} disabled={busy || !run?.id} className="pressable mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg text-sm font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)', opacity: busy || !run?.id ? 0.55 : 1 }}>
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
          <button type="button" onClick={handleShare} disabled={busy} className="pressable flex min-h-12 items-center justify-center gap-2 rounded-lg text-sm font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}><Share2 size={17} /> Share</button>
          <button type="button" onClick={handleSave} disabled={busy} className="pressable flex min-h-12 items-center justify-center gap-2 rounded-lg text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}><Download size={17} /> Save</button>
          <button type="button" onClick={handleCopy} disabled={busy} className="pressable flex min-h-12 items-center justify-center gap-2 rounded-lg text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}><Copy size={17} /> Copy</button>
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
