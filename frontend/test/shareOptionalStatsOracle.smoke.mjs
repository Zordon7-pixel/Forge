// Exercise the exact browser-test callback without Vite/Chromium. Real renderer draws
// and intentional mutations verify the oracle; this does not claim browser pixels.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { studioModel } from '../src/lib/shareStudioModel.js'
import { TEMPLATES } from '../src/lib/shareTemplates.js'
const source = readFileSync(new URL('./activityShareStudioFramework.smoke.mjs', import.meta.url), 'utf8')
const start = source.indexOf("await check('each absent optional stat drops")
assert.ok(start >= 0, 'Framework optional-stat oracle must exist')
const body = source.slice(source.indexOf('async () => {', start) + 13, source.indexOf("\n  await check('model prop", start)).replace(/\n  \}\)\s*$/, '')
const records = new WeakMap()
globalThis.document = { createElement: () => ({}) }
let mutant = null
const h = { studioModel, TEMPLATES, prefs: { friend_handle: 'abc', units: 'imperial', timezone: 'America/New_York' },
  run: { name: 'Morning miles', date: '2026-10-18', distance_miles: 5, duration_seconds: 3000, elevation_gain: 100, calories: 450, avg_heart_rate: 145 },
  drawShareCard: async (canvas, model, options) => {
    const texts = []
    const ctx = new Proxy({ measureText: value => ({ width: String(value).length * 12 }),
      createLinearGradient: () => ({ addColorStop() {} }), fillText: text => texts.push({ text: String(text) }) },
      { get: (target, key) => key in target ? target[key] : () => {} })
    TEMPLATES.find(entry => entry.id === options.template).draw(ctx, model, { ...options, logo: {} })
    if (mutant === 'leak') texts.push({ text: 'DISTANCE' })
    if (mutant === 'empty') texts.length = 0
    records.set(canvas, texts)
  },
}
globalThis.window = { harness: h, records }
const check = new (Object.getPrototypeOf(async function(){}).constructor)('page', 'assert', body)
await check({ evaluate: fn => fn() }, assert)
console.log('PASS exact framework omission callback against real renderers: 12 positive/negative pairs')
for (const mode of ['leak', 'empty']) {
  mutant = mode
  await assert.rejects(check({ evaluate: fn => fn() }, assert), assert.AssertionError)
  console.log(`PASS oracle rejects ${mode} draw mutation`)
}
