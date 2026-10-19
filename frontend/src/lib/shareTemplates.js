import { SIZES, THEMES, FONTS, alpha, loadShareFonts } from './shareTheme.js'
import { rendererModel } from './shareStudioModel.js'

const CARD_WIDTH = SIZES.feed.w
const CARD_HEIGHT = SIZES.feed.h
export function titleForModel(model) { return String(model?.title || 'Run Complete').slice(0, 48) }
function displayStat(item) { return item ? `${item.value}${item.unit ? ` ${item.unit}` : ''}` : '' }
function statValue(model, key, unit = true) {
  const item = model.stats.find(item => item.key === key)
  return item ? (unit ? displayStat(item) : item.value) : ''
}
function formatDate(value) {
  if (!value) return ''
  return new Date(`${value}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function panelPaint(ctx, tokens) {
  if (!tokens.panelGradient) return tokens.panel
  const gradient = ctx.createLinearGradient(0, 0, CARD_WIDTH, CARD_HEIGHT)
  tokens.panelGradient.forEach((color, index) => gradient.addColorStop(index, color))
  return gradient
}
function sparkColor(t, random, opacity) {
  return alpha(random > 0.5 ? t.gold : t.hot, opacity)
}
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

function drawCoverImage(ctx, image, x, y, width, height) {
  const scale = Math.max(width / image.width, height / image.height)
  const drawWidth = image.width * scale
  const drawHeight = image.height * scale
  ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight)
}

function mulberry32(seed) {
  let a = seed | 0
  return function next() {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
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

function drawMicro(ctx, text, x, y, color) {
  ctx.fillStyle = color
  ctx.font = `600 22px ${FONTS.micro}`
  drawTracked(ctx, String(text).toUpperCase(), x, y, 5)
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

function drawStatRow(ctx, items, x, y, gap, t, { dark = true, valueSize = 58 } = {}) {
  let cursor = x
  items.filter(([, value]) => value).forEach(([label, value, width], index) => {
    if (index > 0) {
      ctx.fillStyle = dark ? alpha(t.hot, 0.14) : alpha(t.ink, 0.18)
      ctx.fillRect(cursor - gap / 2, y - 46, 2, 86)
    }
    ctx.fillStyle = t.muted
    ctx.font = `800 21px ${FONTS.label}`
    drawTracked(ctx, label.toUpperCase(), cursor, y, 4)
    ctx.fillStyle = dark ? t.text : t.ink
    ctx.font = `400 ${valueSize}px ${FONTS.hero}`
    ctx.fillText(value, cursor, y + 62)
    cursor += width + gap
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

function drawRouteTemplate(ctx, model, route, logo, t) {
  const ground = ctx.createRadialGradient(CARD_WIDTH / 2, 470, 120, CARD_WIDTH / 2, 600, 900)
  ground.addColorStop(0, t.ground)
  ground.addColorStop(0.55, t.background)
  ground.addColorStop(1, t.edge)
  ctx.fillStyle = ground
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  ctx.strokeStyle = alpha(t.hot, 0.035)
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
  drawBrand(ctx, logo, {}, t)
  if (route.length >= 2) drawRoute(ctx, route, { x: 140, y: 250, width: 800, height: 600 }, t)
  ctx.fillStyle = t.text
  ctx.font = `900 58px ${FONTS.label}`
  ctx.fillText(titleForModel(model), 72, 985)
  drawMicro(ctx, formatDate(model.dateLabel), 74, 1026, t.muted)
  const distance = statValue(model, 'distance', false)
  ctx.fillStyle = t.text
  ctx.font = `400 148px ${FONTS.hero}`
  ctx.fillText(distance, 66, 1210)
  const distanceWidth = ctx.measureText(distance).width
  ctx.fillStyle = t.gold
  ctx.font = `900 40px ${FONTS.label}`
  if (distance) ctx.fillText(model.unit.toUpperCase(), 84 + distanceWidth, 1210)
  drawStatRow(ctx, [
    ['Time', statValue(model, 'time'), 148],
    ['Pace', statValue(model, 'pace'), 192],
    ['Avg HR', statValue(model, 'avgHr', false), 90],
  ], 500, 1122, 42, t, { valueSize: 44 })
}

function drawLogTemplate(ctx, model, logo, t) {
  ctx.fillStyle = t.background
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  roundRect(ctx, 44, 44, CARD_WIDTH - 88, CARD_HEIGHT - 88, 34, panelPaint(ctx, t))
  const rand = mulberry32(7)
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(44, 44, CARD_WIDTH - 88, CARD_HEIGHT - 88, 34)
  ctx.clip()
  for (let x = 44; x < CARD_WIDTH - 44; x += 3) {
    ctx.fillStyle = alpha(t.hot, 0.004 + rand() * 0.014)
    ctx.fillRect(x, 44, 1, CARD_HEIGHT - 88)
  }
  ctx.restore()
  roundRect(ctx, 44, 44, CARD_WIDTH - 88, CARD_HEIGHT - 88, 34, null, alpha(t.hot, 0.10))
  roundRect(ctx, 60, 60, CARD_WIDTH - 120, CARD_HEIGHT - 120, 26, null, alpha(t.shadow, 0.55))
  ;[[92, 92], [CARD_WIDTH - 92, 92], [92, CARD_HEIGHT - 92], [CARD_WIDTH - 92, CARD_HEIGHT - 92]].forEach(([x, y]) => {
    ctx.fillStyle = t.edge
    ctx.beginPath()
    ctx.arc(x, y, 13, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = alpha(t.hot, 0.22)
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.arc(x, y, 13, Math.PI * 0.8, Math.PI * 1.7)
    ctx.stroke()
  })
  drawBrand(ctx, logo, { x: 110, y: 104 }, t)
  ctx.save()
  ctx.shadowColor = alpha(t.shadow, 0.95)
  ctx.shadowOffsetY = 3
  ctx.fillStyle = t.muted
  ctx.font = `900 33px ${FONTS.label}`
  drawTracked(ctx, 'TRAINING LOG', 110, 268, 13)
  ctx.restore()
  const serial = String(model.dateLabel || '').replace(/-/g, '')
  ctx.fillStyle = t.faint
  ctx.font = `800 26px ${FONTS.micro}`
  ctx.textAlign = 'right'
  if (serial) ctx.fillText(`Nº ${serial}`, CARD_WIDTH - 110, 268)
  ctx.textAlign = 'left'
  ctx.fillStyle = alpha(t.hot, 0.10)
  ctx.fillRect(110, 296, CARD_WIDTH - 220, 2)
  ctx.fillStyle = t.text
  ctx.font = `900 68px ${FONTS.label}`
  ctx.fillText(titleForModel(model), 108, 392)
  drawMicro(ctx, formatDate(model.dateLabel), 110, 436, t.muted)
  const rows = model.stats.map(item => [item.label.toUpperCase(), displayStat(item)])
  rows.forEach((row, index) => {
    const y = 560 + index * 104
    ctx.fillStyle = t.muted
    ctx.font = `800 26px ${FONTS.label}`
    const labelEnd = drawTracked(ctx, row[0], 110, y, 4)
    ctx.fillStyle = t.text
    ctx.font = `900 46px ${FONTS.label}`
    ctx.textAlign = 'right'
    ctx.fillText(row[1], CARD_WIDTH - 110, y + 2)
    const valueWidth = ctx.measureText(row[1]).width
    ctx.textAlign = 'left'
    ctx.fillStyle = alpha(t.hot, 0.16)
    for (let dotX = labelEnd + 26; dotX < CARD_WIDTH - 130 - valueWidth; dotX += 16) ctx.fillRect(dotX, y - 6, 4, 4)
    if (index < rows.length - 1) {
      ctx.fillStyle = alpha(t.hot, 0.05)
      ctx.fillRect(110, y + 46, CARD_WIDTH - 220, 1)
    }
  })
  ctx.save()
  ctx.translate(CARD_WIDTH - 330, 1216)
  ctx.rotate(-0.075)
  ctx.strokeStyle = alpha(t.gold, 0.85)
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.roundRect(-10, -46, 232, 72, 10)
  ctx.stroke()
  ctx.fillStyle = alpha(t.gold, 0.9)
  ctx.font = `900 40px ${FONTS.label}`
  drawTracked(ctx, 'FORGED', 22, 6, 8)
  ctx.restore()
  ctx.fillStyle = t.gold
  ctx.font = `900 26px ${FONTS.label}`
  drawTracked(ctx, 'THE WORK ADDS UP.', 110, 1228, 6)
}

function drawEmberTemplate(ctx, model, logo, t) {
  ctx.fillStyle = t.edge
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  const heat = ctx.createLinearGradient(0, 640, 0, CARD_HEIGHT)
  heat.addColorStop(0, alpha(t.heat, 0))
  heat.addColorStop(0.42, alpha(t.heat, 0.55))
  heat.addColorStop(0.78, alpha(t.ember, 0.82))
  heat.addColorStop(1, alpha(t.gold, 0.95))
  ctx.fillStyle = heat
  ctx.fillRect(0, 640, CARD_WIDTH, CARD_HEIGHT - 640)
  const core = ctx.createRadialGradient(CARD_WIDTH / 2, CARD_HEIGHT + 140, 60, CARD_WIDTH / 2, CARD_HEIGHT + 140, 760)
  core.addColorStop(0, alpha(t.hot, 0.85))
  core.addColorStop(0.4, alpha(t.ember, 0.35))
  core.addColorStop(1, alpha(t.ember, 0))
  ctx.fillStyle = core
  ctx.fillRect(0, 560, CARD_WIDTH, CARD_HEIGHT - 560)
  const rand = mulberry32(42)
  for (let i = 0; i < 64; i += 1) {
    const x = rand() * CARD_WIDTH
    const y = 660 + rand() * 640
    const radius = 1.5 + rand() * 4
    const alpha = 0.18 + rand() * 0.6
    ctx.save()
    ctx.shadowColor = rand() > 0.5 ? t.gold : t.hot
    ctx.shadowBlur = 14
    ctx.fillStyle = sparkColor(t, rand(), alpha)
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  drawBrand(ctx, logo, {}, t)
  ctx.fillStyle = t.text
  ctx.font = `900 56px ${FONTS.label}`
  ctx.fillText(titleForModel(model), 72, 258)
  drawMicro(ctx, formatDate(model.dateLabel), 74, 300, t.muted)
  ctx.save()
  ctx.shadowColor = alpha(t.hot, 0.55)
  ctx.shadowBlur = 42
  const distanceGradient = ctx.createLinearGradient(0, 380, 0, 660)
  distanceGradient.addColorStop(0, t.text)
  distanceGradient.addColorStop(1, t.hot)
  ctx.fillStyle = distanceGradient
  ctx.font = `400 252px ${FONTS.hero}`
  ctx.fillText(statValue(model, 'distance', false), 52, 646)
  ctx.restore()
  ctx.fillStyle = t.gold
  ctx.font = `900 44px ${FONTS.label}`
  if (statValue(model, 'distance')) drawTracked(ctx, model.unit === 'km' ? 'KILOMETERS' : 'MILES', 66, 712, 12)
  roundRect(ctx, 60, 880, CARD_WIDTH - 120, 336, 28, alpha(t.edge, 0.88), alpha(t.hot, 0.16))
  const statY = 1020
  drawStatRow(ctx, [
    ['Time', statValue(model, 'time'), 250],
    ['Pace', statValue(model, 'pace'), 268],
    ['Avg HR', statValue(model, 'avgHr'), 210],
  ], 118, statY, 52, t)
  ctx.fillStyle = t.hot
  ctx.font = `900 27px ${FONTS.label}`
  drawTracked(ctx, 'EFFORT IS HEAT.', 66, 1292, 7)
}

function drawContourTemplate(ctx, model, route, logo, t) {
  ctx.fillStyle = t.paper
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  const centerX = CARD_WIDTH / 2
  const centerY = 545
  ctx.strokeStyle = alpha(t.paperMuted, 0.12)
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
  fade.addColorStop(0, alpha(t.paper, 0))
  fade.addColorStop(1, t.paper)
  ctx.fillStyle = fade
  ctx.fillRect(0, 760, CARD_WIDTH, 240)
  drawBrand(ctx, logo, { dark: false }, t)
  if (route.length >= 2) drawRoute(ctx, route, { x: 170, y: 240, width: 740, height: 560 }, t, {
    casing: t.routeCasing,
    glow: alpha(t.route, 0.55),
    gradient: false,
    routeColor: t.route,
    lineWidth: 12,
  })
  ctx.fillStyle = t.ink
  ctx.font = '900 74px Georgia, serif'
  ctx.fillText(titleForModel(model), 96, 1015)
  ctx.fillStyle = emberGradient(ctx, 96, 0, 356, 0, t)
  ctx.fillRect(98, 1042, 190, 5)
  ctx.fillStyle = t.paperMuted
  ctx.font = '700 25px Georgia, serif'
  ctx.fillText(formatDate(model.dateLabel), 98, 1092)
  ctx.fillStyle = alpha(t.ink, 0.16)
  ctx.fillRect(96, 1122, CARD_WIDTH - 192, 2)
  const values = [
    ['Distance', statValue(model, 'distance')],
    ['Time', statValue(model, 'time')],
    ['Pace', statValue(model, 'pace')],
  ]
  values.filter(([, value]) => value).forEach(([label, value], index) => {
    const x = 98 + index * 310
    ctx.fillStyle = t.paperMuted
    ctx.font = `800 21px ${FONTS.label}`
    drawTracked(ctx, label.toUpperCase(), x, 1176, 4)
    ctx.fillStyle = t.ink
    ctx.font = '900 52px Georgia, serif'
    ctx.fillText(value, x, 1244)
  })
}

function drawOverlayTemplate(ctx, model, route, logo, t) {
  ctx.clearRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  roundRect(ctx, 64, 64, 438, 104, 999, alpha(t.edge, 0.78), alpha(t.hot, 0.22))
  if (logo) {
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(82, 80, 72, 72, 999)
    ctx.clip()
    ctx.drawImage(logo, 82, 80, 72, 72)
    ctx.restore()
  }
  ctx.fillStyle = t.hot
  ctx.font = `900 27px ${FONTS.label}`
  drawTracked(ctx, 'FORGED HYBRID', 172, 130, 5)
  if (route.length >= 2) drawRoute(ctx, route, { x: CARD_WIDTH - 372, y: 236, width: 300, height: 300 }, t, {
    casing: alpha(t.shadow, 0.7),
    lineWidth: 9,
  })
  ctx.save()
  ctx.shadowColor = alpha(t.shadow, 0.8)
  ctx.shadowBlur = 26
  ctx.shadowOffsetY = 4
  ctx.fillStyle = emberGradient(ctx, 72, 0, 72, CARD_HEIGHT, t)
  ctx.fillRect(72, 842, 7, 392)
  ctx.fillStyle = t.text
  ctx.font = `900 56px ${FONTS.label}`
  ctx.fillText(titleForModel(model), 118, 900)
  ctx.fillStyle = alpha(t.text, 0.82)
  ctx.font = `800 24px ${FONTS.label}`
  drawTracked(ctx, formatDate(model.dateLabel).toUpperCase(), 120, 944, 5)
  ctx.fillStyle = t.text
  ctx.font = `400 104px ${FONTS.hero}`
  ctx.fillText(statValue(model, 'distance').toUpperCase(), 114, 1066)
  ctx.font = `900 74px ${FONTS.label}`
  const timeText = statValue(model, 'time')
  ctx.fillText(timeText, 114, 1168)
  const timeWidth = ctx.measureText(timeText).width
  ctx.fillStyle = t.hot
  ctx.font = `900 46px ${FONTS.label}`
  ctx.fillText(statValue(model, 'pace'), timeText ? 132 + timeWidth : 114, 1160)
  ctx.restore()
}

function drawPhotoTemplate(ctx, model, photo, logo, t) {
  ctx.fillStyle = t.edge
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  if (photo) {
    drawCoverImage(ctx, photo, 0, 0, CARD_WIDTH, CARD_HEIGHT)
    ctx.fillStyle = alpha(t.gold, 0.05)
    ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
    const gradient = ctx.createLinearGradient(0, CARD_HEIGHT - 720, 0, CARD_HEIGHT - 300)
    gradient.addColorStop(0, alpha(t.edge, 0))
    gradient.addColorStop(1, alpha(t.edge, 0.72))
    ctx.fillStyle = gradient
    ctx.fillRect(0, CARD_HEIGHT - 720, CARD_WIDTH, 420)
  } else {
    const rand = mulberry32(11)
    for (let i = 0; i < 26; i += 1) {
      const x = rand() * CARD_WIDTH
      const y = rand() * 880
      const radius = 1 + rand() * 2.5
      ctx.fillStyle = alpha(t.hot, 0.05 + rand() * 0.12)
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.fill()
    }
    roundRect(ctx, 120, 300, CARD_WIDTH - 240, 480, 28, alpha(t.hot, 0.03), alpha(t.hot, 0.14))
    ctx.strokeStyle = alpha(t.hot, 0.3)
    ctx.lineWidth = 6
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(CARD_WIDTH / 2 - 44, 516)
    ctx.lineTo(CARD_WIDTH / 2 + 44, 516)
    ctx.moveTo(CARD_WIDTH / 2, 472)
    ctx.lineTo(CARD_WIDTH / 2, 560)
    ctx.stroke()
    ctx.fillStyle = t.muted
    ctx.font = `900 30px ${FONTS.label}`
    ctx.textAlign = 'center'
    ctx.fillText('A D D   A   P H O T O', CARD_WIDTH / 2, 640)
    ctx.fillStyle = t.faint
    ctx.font = `700 24px ${FONTS.label}`
    ctx.fillText('It becomes the whole card', CARD_WIDTH / 2, 684)
    ctx.textAlign = 'left'
  }
  drawBrand(ctx, logo, {}, t)
  ctx.fillStyle = emberGradient(ctx, 0, 0, CARD_WIDTH, 0, t)
  ctx.fillRect(0, CARD_HEIGHT - 330, CARD_WIDTH, 6)
  ctx.fillStyle = alpha(t.edge, 0.96)
  ctx.fillRect(0, CARD_HEIGHT - 324, CARD_WIDTH, 324)
  ctx.fillStyle = t.text
  ctx.font = `900 54px ${FONTS.label}`
  ctx.fillText(titleForModel(model), 72, CARD_HEIGHT - 234)
  drawMicro(ctx, formatDate(model.dateLabel), 74, CARD_HEIGHT - 192, t.muted)
  drawStatRow(ctx, [
    ['Distance', statValue(model, 'distance'), 300],
    ['Time', statValue(model, 'time'), 250],
    ['Pace', statValue(model, 'pace'), 240],
  ], 74, CARD_HEIGHT - 108, 56, t)
}


export function footerForModel(model) {
  return `${model.handle ? `${model.handle} / ` : ''}RUN + LIFT. BUILT IN FORGED HYBRID.`
}
const legacyDraws = {
  route: (ctx, model, { logo, tokens, showRoute }) => drawRouteTemplate(ctx, model, showRoute ? model.run?.route || [] : [], logo, tokens),
  log: (ctx, model, { logo, tokens }) => drawLogTemplate(ctx, model, logo, tokens),
  ember: (ctx, model, { logo, tokens }) => drawEmberTemplate(ctx, model, logo, tokens),
  contour: (ctx, model, { logo, tokens, showRoute }) => drawContourTemplate(ctx, model, showRoute ? model.run?.route || [] : [], logo, tokens),
  overlay: (ctx, model, { logo, tokens, showRoute }) => drawOverlayTemplate(ctx, model, showRoute ? model.run?.route || [] : [], logo, tokens),
  photo: (ctx, model, { photo, logo, tokens }) => drawPhotoTemplate(ctx, model, photo, logo, tokens),
}
export const TEMPLATES = Object.freeze([
  ['route', 'Route'], ['log', 'Training Log'], ['ember', 'Ember'], ['contour', 'Contour'], ['overlay', 'Overlay'], ['photo', 'Photo'],
].map(([id, label]) => Object.freeze({
  id, label, supports: model => model?.kind === 'run',
  themes: Object.freeze(['light', 'dark', 'color']), sizes: Object.freeze(['feed', 'story']),
  draw(ctx, model, { theme = id === 'contour' ? 'light' : 'dark', size = 'feed', photo = null, logo = null, showRoute }) {
    if (typeof showRoute !== 'boolean') throw new TypeError('showRoute must be a boolean')
    // Rebuild at the renderer boundary as well: no raw/hidden/META extras enter any template.
    const safeModel = rendererModel(model, showRoute)
    const tokens = THEMES[theme], dimensions = SIZES[size]
    if (!tokens || !dimensions) throw new Error('Unsupported share theme or size')
    ctx.save()
    try {
      ctx.clearRect(0, 0, dimensions.w, dimensions.h)
      if (id !== 'overlay') {
        ctx.fillStyle = tokens.background
        ctx.fillRect(0, 0, dimensions.w, dimensions.h)
      }
      // Uniformly fit the original layout between Story's 250/340 px safe zones.
      if (size === 'story') {
        const scale = (dimensions.h - 250 - 340) / CARD_HEIGHT
        ctx.translate((dimensions.w - CARD_WIDTH * scale) / 2, 250)
        ctx.scale(scale, scale)
      }
      legacyDraws[id](ctx, safeModel, { photo, logo, tokens, showRoute })
      ctx.fillStyle = id === 'contour' ? tokens.ink : tokens.text
      ctx.font = `600 16px ${FONTS.micro}`
      ctx.fillText(footerForModel(safeModel), 72, 1330, CARD_WIDTH - 144)
    } finally { ctx.restore() }
  },
})))

export async function drawShareCard(canvas, model, options) {
  const entry = TEMPLATES.find(item => item.id === options.template && item.supports(model))
  if (!entry) throw new Error('No available template for this activity')
  const dimensions = SIZES[options.size]
  if (!dimensions) throw new Error('Unsupported share size')
  await loadShareFonts()
  canvas.width = dimensions.w
  canvas.height = dimensions.h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Share card could not be created')
  entry.draw(ctx, rendererModel(model, options.showRoute), options)
  return canvas
}
