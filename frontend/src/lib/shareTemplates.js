import { SIZES, THEMES, FONTS, alpha, loadShareFonts } from './shareTheme.js'
import { rendererModel } from './shareStudioModel.js'
import { C1_TEMPLATES, loadC1Logo } from './shareOverlaysC1.js'
import { createC2Templates } from './shareOverlaysC2.js'

export function titleForModel(model) { return String(model?.title || (model?.kind === 'lift' ? 'Lift Complete' : 'Run Complete')).slice(0, 48) }
export function roundRect(ctx, x, y, width, height, radius, fill, stroke = null) {
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

function emberGradient(ctx, x0, y0, x1, y1, t) {
  const gradient = ctx.createLinearGradient(x0, y0, x1, y1)
  gradient.addColorStop(0, t.gold)
  gradient.addColorStop(1, t.ember)
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

export function drawBrand(ctx, logo, { dark = true, x = 72, y = 64 } = {}, t = THEMES.dark) {
  if (logo) {
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(x, y, 64, 64, 16)
    ctx.clip()
    ctx.drawImage(logo, x, y, 64, 64)
    ctx.restore()
  }
  ctx.fillStyle = dark ? t.hot : t.ink
  ctx.font = `900 30px ${FONTS.label}`
  drawTracked(ctx, 'FORGED HYBRID', x + 86, y + 40, 7)
  ctx.fillStyle = emberGradient(ctx, x + 86, 0, x + 326, 0, t)
  ctx.fillRect(x + 86, y + 52, 118, 4)
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

function drawRoute(ctx, route, bounds, t, { casing = t.edge, glow = t.ember, gradient = true, routeColor = t.gold, lineWidth = 11 } = {}) {
  const fitted = fitRoute(route, bounds.x, bounds.y, bounds.width, bounds.height)
  if (fitted.length < 2) return

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
  ctx.strokeStyle = alpha(t.ember, 0.42)
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
    ctx.strokeStyle = emberGradient(ctx, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), t)
  } else {
    ctx.strokeStyle = routeColor
  }
  ctx.lineWidth = lineWidth
  ctx.stroke()

  const [startX, startY] = fitted[0]
  const [endX, endY] = fitted.at(-1)
  ctx.fillStyle = t.start
  ctx.beginPath()
  ctx.arc(startX, startY, 13, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = casing
  ctx.lineWidth = 5
  ctx.stroke()
  ctx.save()
  ctx.shadowColor = t.end
  ctx.shadowBlur = 30
  ctx.fillStyle = t.end
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


export function footerForModel(model) {
  return `${model.handle ? `${model.handle} / ` : ''}RUN + LIFT. BUILT IN FORGED HYBRID.`
}
export const TEMPLATES = Object.freeze([...C1_TEMPLATES, ...createC2Templates(drawRoute)])
export function availableShareTemplates(model, { showRoute, size = 'feed' }) {
  const safe = rendererModel(model, showRoute)
  return TEMPLATES.filter(entry => entry.sizes.includes(size) && entry.supports(safe))
}
export function resolveShareTemplate(model, { template, showRoute, size = 'feed' }) {
  const available = availableShareTemplates(model, { showRoute, size })
  const preferred = available.find(entry => entry.id === template)
  if (preferred) return preferred.id
  // Trace is an explicit choice: recorded geometry is not trimmed for privacy.
  const order = ['strike-pr', 'hybrid-split', ...(model?.streak?.milestone === model?.streak?.days ? ['forged-days'] : []),
    ...(size === 'story' ? ['full-bleed-story'] : []), 'iron-chips', 'full-bleed-story', 'forged-days']
  return order.find(id => available.some(entry => entry.id === id)) || null
}
export function transparentShareTemplate(template, photo) {
  return !photo && ['trace', 'forged-days'].includes(template)
}
export async function drawShareCard(canvas, model, options) {
  const safe = rendererModel(model, options.showRoute)
  const entry = availableShareTemplates(safe, options).find(item => item.id === options.template)
  if (!entry) throw new Error('No available template for this activity')
  const dimensions = SIZES[options.size]
  if (!dimensions) throw new Error('Unsupported share size')
  await loadShareFonts()
  canvas.width = dimensions.w
  canvas.height = dimensions.h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Share card could not be created')
  const logo = options.logo || await loadC1Logo()
  entry.draw(ctx, safe, { ...options, logo })
  return canvas
}
