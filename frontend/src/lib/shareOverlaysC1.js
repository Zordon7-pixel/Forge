import { SIZES, STORY_SAFE, THEMES, BRAND, FONTS, alpha } from './shareTheme.js'
import { rendererModel } from './shareStudioModel.js'

const W = SIZES.feed.w, H = SIZES.feed.h
const RUN_ORDER = ['distance', 'pace', 'time', 'elevation', 'calories', 'avgHr']
const LIFT_ORDER = ['volume', 'sets', 'topSet', 'time', 'calories', 'avgHr', 'reps']
const kinds = ['run', 'lift', 'hybrid']
const display = stat => [stat.value, stat.unit].filter(value => value != null && value !== '').join(' ')
const find = (stats, key) => stats.find(stat => stat.key === key)
const ordered = (stats, keys) => [...keys.flatMap(key => stats.filter(stat => stat.key === key)),
  ...stats.filter(stat => !keys.includes(stat.key) && stat.key !== 'topLifts')]
const topLifts = model => find(model.kind === 'hybrid' ? model.lift?.stats || [] : model.stats, 'topLifts')
  ? (model.lift?.topLifts || []).filter(lift => lift.name && (lift.scheme || lift.weight)) : []
function chips(model) {
  if (model.kind === 'hybrid') return [
    ...ordered(model.stats, ['totalTime', 'calories']),
    ...ordered(model.run?.stats || [], RUN_ORDER).map(stat => ({ ...stat, label: `RUN ${stat.label}` })),
    ...ordered(model.lift?.stats || [], LIFT_ORDER).map(stat => ({ ...stat, label: `LIFT ${stat.label}` })),
  ]
  return ordered(model.stats, model.kind === 'lift' ? LIFT_ORDER : RUN_ORDER)
}
function columns(model) {
  const run = model.run?.stats || [], lift = model.lift?.stats || []
  const preferredRun = ['distance', 'pace', 'time'].flatMap(key => run.filter(stat => stat.key === key))
  const preferredLift = ['volume', 'sets', 'time'].flatMap(key => lift.filter(stat => stat.key === key))
  return { run: preferredRun.length ? preferredRun : run,
    lift: preferredLift.length || topLifts(model).length ? preferredLift : lift.filter(stat => stat.key !== 'topLifts') }
}
function hasPr(model) {
  const pr = model.pr
  return Boolean(pr?.label && pr.unit && (typeof pr.value === 'number' ? pr.value > 0 : pr.value && pr.value !== '0'))
}

let logoPromise
export function loadC1Logo() {
  // Never export an unbranded card if the caller's logo request failed.
  if (!logoPromise) logoPromise = (async () => {
    try {
      const logo = new Image()
      logo.src = '/icon-192.png'
      await logo.decode()
      return logo
    } catch (error) { logoPromise = null; throw new Error('Share brand could not be loaded', { cause: error }) }
  })()
  return logoPromise
}
function gradient(ctx, x, y, w, h, colors) {
  const paint = ctx.createLinearGradient(x, y, x + w, y + h)
  colors.forEach((color, index) => paint.addColorStop(index / (colors.length - 1), color))
  return paint
}
function plate(ctx, x, y, w, h, paint, edge) {
  const cut = Math.min(20, h / 4)
  ctx.beginPath()
  ctx.moveTo(x + cut, y); ctx.lineTo(x + w - cut, y); ctx.lineTo(x + w, y + cut)
  ctx.lineTo(x + w, y + h - cut); ctx.lineTo(x + w - cut, y + h)
  ctx.lineTo(x + cut, y + h); ctx.lineTo(x, y + h - cut); ctx.lineTo(x, y + cut); ctx.closePath()
  ctx.fillStyle = paint; ctx.fill()
  if (edge) { ctx.strokeStyle = edge; ctx.lineWidth = 2; ctx.stroke() }
}
function text(ctx, value, x, y, size, family, color, width, { align = 'left', weight = '400', spacing = 0, italic = false } = {}) {
  if (value == null || value === '') return
  ctx.save()
  ctx.textAlign = align
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = color
  ctx.letterSpacing = `${spacing}px`
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${family}`
  // Fit long real labels/values without clipping or inventing shortened numbers.
  const measured = ctx.measureText(String(value)).width
  if (measured > width) {
    const scale = width / measured
    ctx.font = `${italic ? 'italic ' : ''}${weight} ${size * scale}px ${family}`
    ctx.letterSpacing = `${spacing * scale}px`
  }
  ctx.fillText(String(value), x, y)
  ctx.restore()
}
function label(ctx, value, x, y, width, t, align = 'left') {
  text(ctx, value.toUpperCase(), x, y, 24, FONTS.label, t.muted, width, { weight: '800', spacing: 3, align })
}
function brand(ctx, logo, x, y, t, subtitle = null) {
  ctx.drawImage(logo, x, y, 68, 68)
  text(ctx, 'FORGED', x + 82, y + 51, 46, FONTS.hero, t.text, 214, { spacing: 2 })
  if (subtitle) {
    ctx.fillStyle = BRAND.ember; ctx.fillRect(x + 82, y + 59, 92, 4)
    text(ctx, subtitle, x + 82, y + 82, 16, FONTS.label, t.text, 250, { weight: '800', spacing: 2 })
  }
}
function footer(ctx, model, t, x = 90, y = 1270, width = 900) {
  text(ctx, `${model.handle ? `${model.handle} / ` : ''}RUN + LIFT. BUILT IN FORGED HYBRID.`,
    x, y, 18, FONTS.micro, t.text, width, { weight: '600' })
}
function panel(ctx, t, theme, x, y, w, h) {
  return theme === 'color' ? gradient(ctx, x, y, w, h, t.panelGradient) : alpha(t.panel, theme === 'dark' ? 0.88 : 0.97)
}
function iron(ctx, model, { tokens: t, theme, logo }) {
  const stats = chips(model), lifts = topLifts(model)
  const liftStat = find(model.kind === 'hybrid' ? model.lift?.stats || [] : model.stats, 'topLifts')
  const hasTop = lifts.length > 0 || (!model.lift && Boolean(liftStat))
  const rows = Math.ceil(stats.length / 2) + Number(hasTop)
  const pitch = Math.min(118, 900 / (rows + 1)), height = pitch - 16
  const top = Math.min(562, 1150 - (rows + 1) * pitch)
  const paint = theme === 'light' ? alpha(BRAND.coal, 0.24) : theme === 'color' ? BRAND.ember : alpha(BRAND.coal, 0.88)
  const ink = theme === 'light' ? { ...t, text: BRAND.whiteHot, muted: BRAND.whiteHot } : t
  const edge = theme === 'light' ? BRAND.whiteHot : null
  plate(ctx, 90, top, 326, 100, paint, edge)
  ctx.drawImage(logo, 120, top + 16, 68, 68)
  text(ctx, 'FORGED', 210, top + 72, 52, FONTS.hero, ink.text, 180, { spacing: 3 })
  let tagX = 434
  if (model.dateLabel) {
    plate(ctx, tagX, top, 292, 100, paint, edge)
    text(ctx, model.dateLabel, tagX + 28, top + 63, 31, FONTS.label, ink.text, 236, { weight: '800', spacing: 2 })
    tagX += 310
  }
  const tagWidth = model.kind === 'hybrid' ? 172 : 142
  plate(ctx, tagX, top, tagWidth, 100, BRAND.ember)
  text(ctx, model.kind.toUpperCase(), tagX + tagWidth / 2, top + 63, 32, FONTS.label, BRAND.coal, tagWidth - 34, { weight: '800', align: 'center', spacing: 3 })
  const start = top + 118
  // The reference plates fit their contents: a small tracked label beside one
  // large value. Keep two chips per row, shrinking a crowded pair together.
  function content(caption, value, isTop = false) {
    const small = Math.min(24, height * 0.24), large = Math.min(isTop ? 42 : 59, height * 0.58)
    const family = isTop ? FONTS.label : FONTS.hero, weight = isTop ? '800' : '400'
    ctx.save()
    ctx.letterSpacing = '3px'; ctx.font = `800 ${small}px ${FONTS.label}`
    const labelWidth = ctx.measureText(caption.toUpperCase()).width
    ctx.letterSpacing = '0px'; ctx.font = `${weight} ${large}px ${family}`
    const valueWidth = ctx.measureText(value.toUpperCase()).width
    ctx.restore()
    return { caption: caption.toUpperCase(), value: value.toUpperCase(), small, large, family, weight, labelWidth, valueWidth,
      width: 64 + labelWidth + 16 + valueWidth }
  }
  function drawChip(item, x, y, width) {
    plate(ctx, x, y, width, height, paint, edge)
    const scale = Math.min(1, (width - 64) / (item.width - 64)), baseline = y + height * 0.74
    const labelWidth = item.labelWidth * scale, valueWidth = item.valueWidth * scale
    text(ctx, item.caption, x + 32, baseline, item.small * scale, FONTS.label, ink.muted, labelWidth, { weight: '800', spacing: 3 * scale })
    text(ctx, item.value, x + 32 + labelWidth + 16 * scale, baseline, item.large * scale, item.family, ink.text, valueWidth, { weight: item.weight })
  }
  for (let index = 0; index < stats.length; index += 2) {
    const row = stats.slice(index, index + 2).map(stat => content(stat.label, display(stat)))
    const available = 898 - (row.length - 1) * 16
    const scale = Math.min(1, available / row.reduce((sum, item) => sum + item.width, 0))
    let x = 90
    for (const item of row) {
      const width = item.width * scale
      drawChip(item, x, start + index / 2 * pitch, width)
      x += width + 16
    }
  }
  if (hasTop) {
    const y = start + Math.ceil(stats.length / 2) * pitch
    const value = lifts.length ? lifts.map(lift => [lift.name, lift.weight || lift.scheme].join(' ')).join(' · ') : liftStat.value
    drawChip(content('TOP LIFTS', value, true), 90, y, 898)
  }
  footer(ctx, model, ink)
}
function strike(ctx, model, { tokens: t, theme, logo }) {
  ctx.drawImage(logo, 90, 128, 68, 68)
  text(ctx, 'FORGED', 176, 170, 52, FONTS.hero, t.text, 214, { spacing: 3 })
  ctx.fillStyle = BRAND.ember; ctx.fillRect(176, 179, 104, 4)
  text(ctx, 'HYBRID', 176, 202, 16, FONTS.label, t.text, 250, { weight: '800', spacing: 2 })
  const accent = theme === 'color' ? gradient(ctx, 150, 300, 780, 0, [BRAND.ember, BRAND.gold])
    : theme === 'light' ? t.text : BRAND.ember
  ctx.save()
  ctx.strokeStyle = accent; ctx.lineWidth = 5; ctx.lineCap = 'round'
  for (let i = 0; i < 15; i++) {
    const angle = Math.PI + i * Math.PI / 14
    ctx.beginPath()
    ctx.moveTo(540 + Math.cos(angle) * 420, 510 + Math.sin(angle) * 215)
    ctx.lineTo(540 + Math.cos(angle) * 500, 510 + Math.sin(angle) * (i % 2 ? 285 : 250))
    ctx.stroke()
  }
  ctx.restore()
  text(ctx, 'NEW PR', 540, 548, 248, FONTS.hero, accent, 780, { align: 'center', italic: true })
  ctx.fillStyle = accent; ctx.fillRect(150, 600, 780, 12)
  text(ctx, model.pr.label.toUpperCase(), 540, 694, 42, FONTS.label, t.text, 900, { align: 'center', weight: '800', spacing: 8 })
  // Keep the real value and its smaller unit together on one baseline. Fit the
  // whole group for long values/units without changing or abbreviating either.
  ctx.save()
  ctx.letterSpacing = '0px'; ctx.font = `400 230px ${FONTS.hero}`
  const valueWidth = ctx.measureText(String(model.pr.value)).width
  ctx.font = `600 64px ${FONTS.label}`
  const unitWidth = ctx.measureText(model.pr.unit).width
  ctx.restore()
  const gap = 20, width = valueWidth + gap + unitWidth, scale = Math.min(1, 900 / width)
  const left = (W - width * scale) / 2
  text(ctx, model.pr.value, left, 920, 230 * scale, FONTS.hero, t.text, valueWidth * scale)
  text(ctx, model.pr.unit, left + (valueWidth + gap) * scale, 920, 64 * scale, FONTS.label, t.text, unitWidth * scale, { weight: '600' })
  let microY = 980
  if (model.pr.delta != null && model.pr.delta !== '') {
    const delta = typeof model.pr.delta === 'number' ? `${model.pr.delta} ${model.pr.unit}` : model.pr.delta
    text(ctx, `${delta}${/vs prev best/i.test(delta) ? '' : ' vs prev best'}`, 540, 980, 34, FONTS.micro, t.text, 900, { align: 'center' })
    microY += 52
  }
  text(ctx, [model.dateLabel, model.kind.toUpperCase(), 'STRUCK WHILE HOT'].filter(Boolean).join(' · '),
    540, microY, 28, FONTS.label, t.text, 900, { align: 'center', weight: '800', spacing: 4 })
  text(ctx, `${model.handle ? `${model.handle} / ` : ''}RUN + LIFT. BUILT IN FORGED HYBRID.`,
    540, 1262, 20, FONTS.micro, t.text, 900, { align: 'center', weight: '600' })
}
function hybrid(ctx, model, { tokens: t, theme, logo }) {
  const x = 70, y = 430, w = 940, h = 780, cut = 30
  // Hybrid's reference has only the opposing top-left/bottom-right chamfers.
  ctx.beginPath()
  ctx.moveTo(x + cut, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h - cut)
  ctx.lineTo(x + w - cut, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + cut); ctx.closePath()
  ctx.fillStyle = panel(ctx, t, theme, x, y, w, h); ctx.fill()
  brand(ctx, logo, 108, y + 32, t, 'HYBRID SESSION')
  text(ctx, model.dateLabel, 970, y + 65, 25, FONTS.label, t.muted, 400, { align: 'right', weight: '800', spacing: 2 })
  const total = find(model.stats, 'totalTime')
  if (total) text(ctx, `${display(total)} TOTAL`, 970, y + 99, 28, FONTS.label, t.text, 400, { align: 'right', weight: '800', spacing: 2 })
  ctx.fillStyle = alpha(t.text, 0.22); ctx.fillRect(538, y + 190, 3, 520)
  ctx.beginPath(); ctx.arc(540, y + 442, 42, 0, Math.PI * 2)
  ctx.fillStyle = theme === 'color' ? BRAND.coal : BRAND.ember; ctx.fill()
  text(ctx, '+', 540, y + 458, 46, FONTS.label, theme === 'color' ? BRAND.gold : BRAND.coal, 50, { align: 'center', weight: '800' })
  const sides = columns(model)
  const rows = { run: sides.run.map(stat => ({ label: stat.label, value: display(stat), hero: stat.key === 'distance' })), lift: [] }
  const volume = find(sides.lift, 'volume')
  if (volume) rows.lift.push({ label: volume.label, value: display(volume), hero: true })
  const paired = sides.lift.filter(stat => ['sets', 'time'].includes(stat.key))
  if (paired.length) rows.lift.push({ label: paired.map(stat => stat.label).join(' · '), value: paired.map(display).join(' · ') })
  sides.lift.filter(stat => !['volume', 'sets', 'time'].includes(stat.key)).forEach(stat => rows.lift.push({ label: stat.label, value: display(stat) }))
  const lifts = topLifts(model)
  for (const [side, left] of [['run', 110], ['lift', 600]]) {
    text(ctx, side.toUpperCase(), left, y + 256, 46, FONTS.label, t.text, 370, { weight: '800', spacing: 2 })
    let cursor = y + 312
    const available = 390 - (side === 'lift' ? lifts.length * 34 : 0)
    const scale = Math.min(1, available / Math.max(1, rows[side].reduce((height, row) => height + (row.hero ? 150 : 114), 0)))
    rows[side].forEach(row => {
      label(ctx, row.label, left, cursor, 370, t)
      text(ctx, row.value.toUpperCase(), left, cursor + (row.hero ? 94 : 62) * scale, (row.hero ? 98 : 66) * scale, FONTS.hero, t.text, 370)
      cursor += (row.hero ? 150 : 114) * scale
    })
    if (side === 'lift') lifts.forEach(lift => {
      text(ctx, [lift.name, lift.scheme, lift.weight ? `@ ${lift.weight}` : null].filter(Boolean).join(' '), left, cursor, 22, FONTS.micro, t.text, 370)
      cursor += 34
    })
  }
  const calories = find(model.stats, 'calories')
  footer(ctx, model, t, 110, y + 724, calories ? 660 : 860)
  if (calories) text(ctx, display(calories).toUpperCase(), 970, y + 724, 20, FONTS.label, t.muted, 180, { align: 'right', weight: '800', spacing: 2 })
}
const definitions = [
  ['iron-chips', 'Iron Chips', model => kinds.includes(model.kind) && (chips(model).length > 0 || topLifts(model).length > 0 || (!model.lift && Boolean(find(model.stats, 'topLifts')))), iron],
  ['strike-pr', 'Strike PR', model => kinds.includes(model.kind) && hasPr(model), strike],
  ['hybrid-split', 'Hybrid Split', model => model.kind === 'hybrid' && Boolean(model.run?.stats.length && model.lift?.stats.length
    && columns(model).run.length && (columns(model).lift.length || topLifts(model).length)), hybrid],
]
export const C1_TEMPLATES = Object.freeze(definitions.map(([id, label, supports, draw]) => Object.freeze({
  id, label, supports: model => supports(rendererModel(model, false)),
  themes: Object.freeze(['light', 'dark', 'color']), sizes: Object.freeze(['feed', 'story']),
  draw(ctx, model, { theme = 'dark', size = 'feed', photo = null, logo = null, showRoute }) {
    const safe = rendererModel(model, showRoute), dimensions = SIZES[size], tokens = THEMES[theme]
    if (!dimensions || !tokens) throw new Error('Unsupported share theme or size')
    if (!supports(safe)) throw new Error('No available template for this activity')
    if (!logo) throw new Error('Share brand is required')
    ctx.save()
    try {
      ctx.clearRect(0, 0, dimensions.w, dimensions.h)
      if (photo) {
        // Bare C1 designs are overlays. Only a selected photo gets an opaque
        // backing, including photos whose own pixels contain transparency.
        ctx.fillStyle = tokens.background; ctx.fillRect(0, 0, dimensions.w, dimensions.h)
        const scale = Math.max(dimensions.w / photo.width, dimensions.h / photo.height)
        ctx.drawImage(photo, (dimensions.w - photo.width * scale) / 2, (dimensions.h - photo.height * scale) / 2, photo.width * scale, photo.height * scale)
        ctx.fillStyle = alpha(tokens.background, theme === 'light' ? 0.28 : 0.4)
        ctx.fillRect(0, 0, dimensions.w, dimensions.h)
      }
      if (size === 'story') {
        const scale = (STORY_SAFE.bottom - STORY_SAFE.top) / H
        ctx.translate((dimensions.w - W * scale) / 2, STORY_SAFE.top); ctx.scale(scale, scale)
      }
      draw(ctx, safe, { tokens, theme, logo })
    } finally { ctx.restore() }
  },
})))

// Shared drawing primitives keep Full-Bleed typography aligned with C1.
export const overlayDrawing = Object.freeze({ text, brand, footer, plate, gradient, display })
