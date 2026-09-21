import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { canonicalRunStructure } from '../src/lib/weeklyRunBrief.js'

// Exercise LogRun's actual normalizer with React's real child renderer. This
// needs no browser, provider, network, or production data.
const source = readFileSync(new URL('../src/pages/LogRun.jsx', import.meta.url), 'utf8')
const start = source.indexOf('function normalizeSteps(')
const end = source.indexOf('\nfunction parseSplits', start)
assert.ok(start >= 0 && end > start)
const normalizeSteps = vm.runInNewContext(`(${source.slice(start, end)})`, { canonicalRunStructure })
const render = value => renderToStaticMarkup(React.createElement('div', null,
  normalizeSteps(value).map((step, index) => React.createElement('p', { key: index }, step))))
const canonical = [{ step_id: 'synthetic-step', type: 'repeat', repeat_count: 2, children: [
  { step_id: 'synthetic-run', type: 'run', target: { duration_s: 120, rpe_range: { minimum: 2, maximum: 4 } } },
] }]
for (const value of [canonical, JSON.stringify(canonical)]) {
  let markup
  assert.doesNotThrow(() => { markup = render(value) }, 'canonical scheduled steps must be renderable in LogRun')
  assert.match(markup, /Repeat × 2/)
  assert.match(markup, /2 min/)
  assert.match(markup, /RPE: 2–4/)
}
assert.match(render(['Keep breathing relaxed', 'Walk whenever needed']), /Walk whenever needed/)
assert.match(render('Warm up\n• Run easy'), /Run easy/)
assert.match(render([null, { unknown: { malformed: true } }, 17]), /Workout step unavailable/)
assert.equal(render(null), '<div></div>')
console.log('LogRun step render regression passed (canonical, JSON, recovery, legacy, malformed).')
