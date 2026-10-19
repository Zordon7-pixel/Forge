export const SIZES = Object.freeze({ feed: Object.freeze({ w: 1080, h: 1350 }), story: Object.freeze({ w: 1080, h: 1920 }) })
export const BRAND = Object.freeze({ gold: '#EAB308', ember: '#F97316', coal: '#0C0A07', steel: '#16130D', whiteHot: '#FFF6DC' })
export const FONTS = Object.freeze({ hero: 'Anton, sans-serif', label: '"Barlow Condensed", sans-serif', micro: '"JetBrains Mono", monospace' })
export function alpha(hex, opacity) {
  return `rgba(${[1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16)).join(',')},${opacity})`
}
const dark = {
  background: BRAND.coal, panel: BRAND.steel, text: BRAND.whiteHot, muted: '#8E877A', faint: '#5B5648',
  gold: BRAND.gold, ember: BRAND.ember, hot: BRAND.whiteHot, edge: '#070503', ground: '#171208',
  paper: BRAND.coal, ink: BRAND.whiteHot, paperMuted: '#8E877A', route: BRAND.ember, routeCasing: BRAND.coal,
  start: '#22C55E', end: '#EF4444', heat: '#A03A10', shadow: '#000000',
}
export const THEMES = Object.freeze({
  dark: Object.freeze(dark),
  light: Object.freeze({ ...dark, background: '#F5EEDC', panel: '#FFF6DC', text: BRAND.coal, muted: '#6E6656',
    faint: '#8A8272', gold: BRAND.ember, hot: BRAND.coal, edge: '#EFE9DB', ground: '#FFF6DC',
    paper: '#EFE9DB', ink: BRAND.coal, paperMuted: '#8A8272', route: '#B84A17', routeCasing: '#F7F2E6' }),
  color: Object.freeze({ ...dark, background: BRAND.gold, panel: BRAND.ember, text: BRAND.coal, muted: BRAND.steel,
    faint: BRAND.coal, gold: BRAND.coal, ember: BRAND.coal, hot: BRAND.coal, edge: BRAND.ember,
    panelGradient: Object.freeze([BRAND.gold, BRAND.ember]), ground: BRAND.gold, paper: BRAND.gold, ink: BRAND.coal, paperMuted: BRAND.steel, route: BRAND.coal }),
})

let fontsReady
export function loadShareFonts() {
  if (fontsReady) return fontsReady
  fontsReady = (async () => {
    if (typeof FontFace === 'undefined' || !document.fonts) return
    const faces = [
      ['Anton', new URL('../assets/share-fonts/Anton-Regular.ttf', import.meta.url), '400'],
      ['Barlow Condensed', new URL('../assets/share-fonts/BarlowCondensed-SemiBold.ttf', import.meta.url), '600'],
      ['Barlow Condensed', new URL('../assets/share-fonts/BarlowCondensed-ExtraBold.ttf', import.meta.url), '800'],
      ['JetBrains Mono', new URL('../assets/share-fonts/JetBrainsMono.ttf', import.meta.url), '100 900'],
    ]
    let expired = false
    let timer
    const loading = (async () => {
      await Promise.all(faces.map(async ([family, url, weight]) => {
        try {
          const face = await new FontFace(family, `url("${url}")`, { weight }).load()
          if (!expired) document.fonts.add(face)
        } catch (error) {
          console.warn('[ActivityShareStudio] font fallback:', family, error?.message || error)
        }
      }))
      await document.fonts.ready
    })()
    try {
      // A stalled font request must not stall Save/Share indefinitely.
      await Promise.race([loading, new Promise(resolve => {
        timer = setTimeout(() => {
          expired = true
          console.warn('[ActivityShareStudio] font deadline reached; using available fonts')
          resolve()
        }, 3000)
      })])
    } catch (error) {
      console.warn('[ActivityShareStudio] font readiness fallback:', error?.message || error)
    } finally { clearTimeout(timer) }
  })()
  return fontsReady
}
