import { SIZES, STORY_SAFE, THEMES, BRAND, FONTS, alpha } from './shareTheme.js'
import { rendererModel } from './shareStudioModel.js'
import { overlayDrawing } from './shareOverlaysC1.js'

const { text, brand, footer, plate, gradient, display } = overlayDrawing
const W = SIZES.feed.w, H = SIZES.feed.h
const find = (model, key) => model.stats.find(stat => stat.key === key)
const gps = model => model.kind === 'run' && model.run?.route?.length >= 2
const observed = day => typeof day === 'boolean' ? day
  : day?.hasRun === true || day?.hasLift === true ? true
    : day?.hasRun === false && day?.hasLift === false ? false
      : typeof day?.active === 'boolean' ? day.active : null
function weekHistory(streak) {
  const days = streak?.week
  if (days?.length !== 7 || !days.some(day => observed(day) !== null)) return null
  if (!days.some(day => day?.date)) return days // Contract order: Monday through Sunday.
  if (days.some(day => !day?.date)) return null
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date))
  const start = new Date(`${sorted[0].date}T12:00:00Z`)
  if (start.getUTCDay() !== 1 || sorted.some((day, i) =>
    new Date(`${day.date}T12:00:00Z`).getTime() !== start.getTime() + i * 86400000)) return null
  return sorted
}
function monthHistory(streak) {
  const days = streak?.monthDays
  if (!days?.length || days.some(day => !day?.date || observed(day) === null)) return null
  const dates = days.map(day => day.date)
  if (new Set(dates).size !== dates.length || dates.some(date => date.slice(0, 7) !== dates[0].slice(0, 7))) return null
  return [...days].sort((a, b) => a.date.localeCompare(b.date))
}
export function streakLayouts(model) {
  const streak = rendererModel(model, false).streak
  if (!streak) return []
  const layouts = []
  if (streak.milestone) layouts.push('milestone')
  if (weekHistory(streak)) layouts.push('week')
  if (monthHistory(streak)) layouts.push('month')
  // A streak count is real evidence; it does not imply seven day flags or a calendar.
  return layouts.length ? layouts : ['count']
}
function header(ctx, model, t, logo) {
  brand(ctx, logo, 90, 92, t)
  text(ctx, model.dateLabel, 990, 121, 24, FONTS.label, t.text, 450, { align: 'right', weight: '800', spacing: 3 })
  text(ctx, model.title?.toUpperCase(), 990, 158, 24, FONTS.label, t.text, 450, { align: 'right', weight: '800', spacing: 2 })
}
function hero(ctx, stat, x, y, width, t, size = 218) {
  if (!stat) return
  const value = String(stat.value), unit = stat.unit?.toUpperCase() || ''
  ctx.save()
  ctx.font = `400 ${size}px ${FONTS.hero}`
  const valueWidth = ctx.measureText(value).width
  ctx.font = `800 52px ${FONTS.label}`
  const unitWidth = unit ? ctx.measureText(unit).width + 18 : 0
  ctx.restore()
  const scale = Math.min(1, width / (valueWidth + unitWidth))
  text(ctx, value, x, y, size * scale, FONTS.hero, t.text, valueWidth * scale)
  if (unit) text(ctx, unit, x + (valueWidth + 18) * scale, y, 52 * scale, FONTS.label, t.text, unitWidth * scale, { weight: '800' })
}
function runDetails(ctx, model, t, y) {
  const values = ['pace', 'time'].map(key => find(model, key)).filter(Boolean)
  text(ctx, values.map(display).join('   ·   '), 90, y, 32, FONTS.micro, t.text, 880, { weight: '600' })
}
function elevation(ctx, model, t) {
  const profile = model.run?.elevationProfile
  if (!profile || profile.length < 2) return
  const low = Math.min(...profile), high = Math.max(...profile), span = Math.max(high - low, 1)
  const points = profile.map((value, i) => [90 + i / (profile.length - 1) * 900, 1150 - (value - low) / span * 95])
  ctx.beginPath(); ctx.moveTo(90, 1160)
  points.forEach(([x, y]) => ctx.lineTo(x, y))
  ctx.lineTo(990, 1160); ctx.closePath()
  ctx.fillStyle = gradient(ctx, 0, 1050, 0, 115, [alpha(BRAND.ember, 0.8), alpha(BRAND.ember, 0)])
  ctx.fill()
  ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))
  ctx.strokeStyle = BRAND.gold; ctx.lineWidth = 3; ctx.stroke()
  const gain = find(model, 'elevation')
  if (gain) text(ctx, `ELEV GAIN ${display(gain).toUpperCase()}`, 90, 1195, 22, FONTS.label, t.text, 900, { weight: '800', spacing: 2 })
}
function trace(ctx, model, { tokens: t, theme, logo, drawRoute }) {
  header(ctx, model, t, logo)
  const color = theme === 'color', distance = find(model, 'distance')
  drawRoute(ctx, model.run.route, { x: 170, y: color ? (distance ? 510 : 350) : 275, width: 740, height: color ? (distance ? 475 : 635) : 620 },
    { ...t, gold: BRAND.gold, ember: BRAND.ember, start: BRAND.whiteHot, end: BRAND.gold },
    { casing: alpha(BRAND.coal, 0.65), glow: theme === 'light' ? alpha(BRAND.whiteHot, 0) : BRAND.ember,
      gradient: theme !== 'light', routeColor: BRAND.whiteHot, lineWidth: theme === 'light' ? 9 : 11 })
  hero(ctx, distance, 90, color ? 410 : 1140, 900, t)
  runDetails(ctx, model, t, color ? (distance ? 465 : 285) : (distance ? 1200 : 1035))
  if (color) elevation(ctx, model, t)
  footer(ctx, model, t)
}
function weekRing(ctx, streak, t) {
  const cx = 540, cy = 635, radius = 275, week = weekHistory(streak)
  week.forEach((day, i) => {
    const start = -Math.PI / 2 + i * 2 * Math.PI / 7 + 0.045, end = start + 2 * Math.PI / 7 - 0.09
    ctx.beginPath(); ctx.arc(cx, cy, radius, start, end)
    ctx.lineWidth = 48; ctx.lineCap = 'butt'
    ctx.strokeStyle = observed(day) === true && !day?.isFuture ? BRAND.ember : alpha(t.muted, observed(day) === null ? 0.15 : 0.4)
    ctx.stroke()
    const angle = (start + end) / 2
    text(ctx, ['M', 'T', 'W', 'T', 'F', 'S', 'S'][i], cx + Math.cos(angle) * 335, cy + Math.sin(angle) * 335 + 10,
      27, FONTS.label, t.text, 50, { align: 'center', weight: '800' })
  })
  text(ctx, streak.days, cx, cy + 25, 210, FONTS.hero, BRAND.ember, 450, { align: 'center' })
  text(ctx, 'FORGED DAYS', cx, cy + 89, 32, FONTS.label, t.text, 440, { align: 'center', weight: '800', spacing: 6 })
  const summary = []
  if (week.every(day => observed(day) !== null)) summary.push(`${week.filter(day => observed(day) === true && !day?.isFuture).length} OF 7 THIS WEEK`)
  for (const [key, label] of [['hasRun', 'RUNS'], ['hasLift', 'LIFTS']]) {
    if (week.every(day => typeof day?.[key] === 'boolean')) summary.push(`${week.filter(day => day[key] && !day.isFuture).length} ${label}`)
  }
  text(ctx, summary.join(' · '), cx, 1080, 25, FONTS.label, t.text, 900, { align: 'center', weight: '800', spacing: 2 })
}
function monthGrid(ctx, streak, t) {
  const days = monthHistory(streak), first = new Date(`${days[0].date.slice(0, 7)}-01T12:00:00Z`)
  const offset = (first.getUTCDay() + 6) % 7
  const month = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).toUpperCase()
  text(ctx, `${streak.days} FORGED`, 90, 365, 114, FONTS.hero, t.text, 900)
  text(ctx, `DAYS IN A ROW · ${month}`, 90, 420, 28, FONTS.label, t.text, 900, { weight: '800', spacing: 3 })
  ;['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach((value, i) => text(ctx, value, 146 + i * 130, 480, 24, FONTS.label, t.muted, 110, { align: 'center', weight: '800' }))
  // Missing dates remain empty space, never inferred rest or forged days.
  for (const day of days) {
    const n = Number(day.date.slice(8)), cell = offset + n - 1, x = 90 + cell % 7 * 130, y = 500 + Math.floor(cell / 7) * 108
    const fill = day.isToday ? BRAND.whiteHot : observed(day) && !day.isFuture ? BRAND.ember : alpha(t.muted, day.isFuture ? 0.15 : 0.35)
    plate(ctx, x, y, 114, 92, fill)
    text(ctx, n, x + 57, y + 61, 34, FONTS.label, day.isToday || observed(day) ? BRAND.coal : t.text, 90, { align: 'center', weight: '800' })
  }
}
function forgedDays(ctx, model, { tokens: t, theme, logo, layout }) {
  brand(ctx, logo, 90, 92, t)
  const streak = model.streak, layouts = streakLayouts(model)
  const selected = layouts.includes(layout) ? layout : layouts[0]
  if (selected === 'week') weekRing(ctx, streak, t)
  else if (selected === 'month') monthGrid(ctx, streak, t)
  else {
    if (selected === 'milestone') text(ctx, 'MILESTONE', 540, 385, 36, FONTS.label, t.text, 900, { align: 'center', weight: '800', spacing: 10 })
    const paint = theme === 'light' ? BRAND.ember : gradient(ctx, 190, 480, 700, 300, [BRAND.gold, BRAND.ember])
    text(ctx, streak.days, 540, 840, 380, FONTS.hero, paint, 900, { align: 'center' })
    text(ctx, 'FORGED DAYS', 540, 945, 90, FONTS.label, t.text, 900, { align: 'center', weight: '800', spacing: 5 })
    if (selected === 'milestone') text(ctx, (streak.lifetime || []).map(stat => `${display(stat)}${stat.unit ? '' : ` ${stat.label}`}`).join(' · ').toUpperCase(),
      540, 1040, 26, FONTS.micro, t.text, 900, { align: 'center' })
  }
  footer(ctx, model, t)
}
export function createC2Templates(drawRoute) {
  const definitions = [
    ['trace', 'Trace', gps, trace],
    ['forged-days', 'Forged Days', model => Boolean(model.streak?.days >= 1), forgedDays],
  ]
  return definitions.map(([id, label, supports, draw]) => Object.freeze({
    id, label, themes: Object.freeze(['light', 'dark', 'color']), sizes: Object.freeze(['feed', 'story']),
    supports: (model, options = { showRoute: true }) => supports(rendererModel(model, options.showRoute)),
    draw(ctx, model, { theme = 'dark', size = 'feed', photo = null, logo = null, showRoute, layout } = {}) {
      const safe = rendererModel(model, showRoute), dimensions = SIZES[size], tokens = THEMES[theme]
      if (!dimensions || !tokens) throw new Error('Unsupported share theme or size')
      if (!supports(safe)) throw new Error('No available template for this activity')
      if (!logo) throw new Error('Share brand is required')
      ctx.save()
      try {
        ctx.clearRect(0, 0, dimensions.w, dimensions.h)
        if (photo) {
          // Even a transparent photo must produce an opaque JPEG composite.
          ctx.fillStyle = tokens.background; ctx.fillRect(0, 0, dimensions.w, dimensions.h)
          const scale = Math.max(dimensions.w / photo.width, dimensions.h / photo.height)
          ctx.drawImage(photo, (dimensions.w - photo.width * scale) / 2, (dimensions.h - photo.height * scale) / 2, photo.width * scale, photo.height * scale)
          ctx.fillStyle = alpha(tokens.background, theme === 'light' ? 0.22 : 0.35)
          ctx.fillRect(0, 0, dimensions.w, dimensions.h)
        }
        if (size === 'story') {
          const scale = (STORY_SAFE.bottom - STORY_SAFE.top) / H
          ctx.translate((dimensions.w - W * scale) / 2, STORY_SAFE.top); ctx.scale(scale, scale)
        }
        draw(ctx, safe, { tokens, theme, logo, drawRoute, layout })
      } finally { ctx.restore() }
    },
  }))
}
