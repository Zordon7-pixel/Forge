import { SIZES, STORY_SAFE, THEMES, BRAND, FONTS, alpha } from './shareTheme.js'
import { rendererModel } from './shareStudioModel.js'
import { overlayDrawing } from './shareOverlaysC1.js'

const { text, brand, footer, plate, gradient, display } = overlayDrawing
const W = SIZES.feed.w, H = SIZES.feed.h
const find = (model, key) => model.stats.find(stat => stat.key === key)
const gps = model => model.kind === 'run' && model.run?.route?.length >= 2
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
function fullBleed(ctx, model, { tokens: t, logo, drawRoute }) {
  header(ctx, model, t, logo)
  text(ctx, `${model.kind.toUpperCase()} · FORGED`, 90, 740, 30, FONTS.label, BRAND.ember, 900, { weight: '800', spacing: 5 })
  const main = find(model, model.kind === 'run' ? 'distance' : 'volume')
  hero(ctx, main, 90, 955, gps(model) ? 620 : 900, t, 220)
  if (gps(model)) drawRoute(ctx, model.run.route, { x: 790, y: 790, width: 175, height: 175 },
    { ...t, gold: BRAND.gold, ember: BRAND.ember, start: BRAND.whiteHot, end: BRAND.gold }, { casing: alpha(BRAND.coal, 0.6), lineWidth: 7 })
  const keys = model.kind === 'run' ? ['pace', 'time', 'elevation', 'avgHr', 'calories'] : ['sets', 'topSet', 'time', 'avgHr', 'calories']
  const stats = keys.map(key => find(model, key)).filter(Boolean)
  stats.forEach((stat, i) => {
    const x = 90 + i % 3 * 310, y = (main || gps(model) ? 1020 : 840) + Math.floor(i / 3) * 104
    text(ctx, stat.label.toUpperCase(), x, y, 23, FONTS.label, t.muted, 285, { weight: '800', spacing: 2 })
    text(ctx, display(stat), x, y + 58, 49, FONTS.hero, t.text, 285)
  })
  footer(ctx, model, t, 90, 1268, 500)
  plate(ctx, 620, 1227, 370, 56, BRAND.ember)
  text(ctx, 'TRAIN WITH ME ON FORGED →', 805, 1263, 23, FONTS.label, BRAND.coal, 330, { align: 'center', weight: '800', spacing: 1 })
}
// Selective Full-Bleed port from preserved C2 f895e160; no other C2 designs.
export function createFullBleedTemplate(drawRoute) {
  const supports = model => ['run', 'lift'].includes(model.kind)
  return Object.freeze({
    id: 'full-bleed-story', label: 'Full-Bleed Story',
    themes: Object.freeze(['light', 'dark', 'color']), sizes: Object.freeze(['feed', 'story']),
    supports: model => supports(rendererModel(model, false)),
    draw(ctx, model, { theme = 'dark', size = 'feed', photo = null, logo = null, showRoute } = {}) {
      const safe = rendererModel(model, showRoute), dimensions = SIZES[size], tokens = THEMES[theme]
      if (!dimensions || !tokens) throw new Error('Unsupported share theme or size')
      if (!supports(safe)) throw new Error('No available template for this activity')
      if (!logo) throw new Error('Share brand is required')
      ctx.save()
      try {
        ctx.clearRect(0, 0, dimensions.w, dimensions.h)
        ctx.fillStyle = theme === 'color' ? gradient(ctx, 0, 0, 0, dimensions.h, tokens.panelGradient) : tokens.background
        ctx.fillRect(0, 0, dimensions.w, dimensions.h)
        if (photo) {
          const scale = Math.max(dimensions.w / photo.width, dimensions.h / photo.height)
          ctx.drawImage(photo, (dimensions.w - photo.width * scale) / 2, (dimensions.h - photo.height * scale) / 2, photo.width * scale, photo.height * scale)
          // A faint top scrim keeps the header legible; the lower fade grounds stats.
          ctx.fillStyle = gradient(ctx, 0, dimensions.h * 0.3, 0, dimensions.h * 0.5,
            [alpha(tokens.background, 0.35), theme === 'color' ? BRAND.ember : tokens.background])
          ctx.fillRect(0, 0, dimensions.w, dimensions.h)
        }
        if (size === 'story') {
          const scale = (STORY_SAFE.bottom - STORY_SAFE.top) / H
          ctx.translate((dimensions.w - W * scale) / 2, STORY_SAFE.top); ctx.scale(scale, scale)
        }
        fullBleed(ctx, safe, { tokens, logo, drawRoute })
      } finally { ctx.restore() }
    },
  })
}
