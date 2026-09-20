import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { injectPlannerRenderFailure } from './e2e/support/plannerRenderFixture.mjs'

const aliased = 'function P$(){return "original"}const ns=Object.freeze(Object.defineProperty({__proto__:null,default:P$},Symbol.toStringTag,{value:"Module"}));export{P$ as R,ns as a};'
const direct = 'export default function Planner(){return "original"}'
globalThis.window = { syntheticPlannerReady: false }
try {
  const oldFixture = await import(`data:text/javascript,${encodeURIComponent(direct)}`)
  assert.equal(oldFixture.a, undefined, 'old default-only fixture cannot satisfy the built module.a projection')
  for (const [source, select] of [[aliased, module => module.a.default], [direct, module => module.default]]) {
    const module = await import(`data:text/javascript,${encodeURIComponent(injectPlannerRenderFailure(source))}`)
    const planner = select(module)
    window.syntheticPlannerReady = false
    assert.throws(() => planner(), /Synthetic planner render failure/)
    window.syntheticPlannerReady = true
    assert.equal(planner(), 'Synthetic planner recovered')
    if (module.a) assert.equal(module.R, planner, 'named and namespace exports retain component identity')
  }
  assert.throws(() => injectPlannerRenderFailure('export default () => null'), /Cannot identify/)
  assert.throws(() => injectPlannerRenderFailure('const Missing=()=>null;const ns=Object.freeze(Object.defineProperty({default:Missing},Symbol.toStringTag,{value:"Module"}));'), /Expected one/)
  // Canonical QA runs smoke before build. Check a local chunk when available;
  // e2e provides the mandatory proof against the actual production chunk.
  const assets = new URL('../dist/assets/', import.meta.url)
  if (existsSync(assets)) {
    const chunks = readdirSync(assets).filter(name => /^RoutePlanner-.*\.js$/.test(name))
    assert.equal(chunks.length, 1, 'expected one RoutePlanner chunk in existing build assets')
    const source = readFileSync(new URL(chunks[0], assets), 'utf8')
    const injected = injectPlannerRenderFailure(source)
    assert.equal(injected.match(/export\{[^}]+\}/g)?.join(), source.match(/export\{[^}]+\}/g)?.join())
    assert.ok(injected.includes("throw new Error('Synthetic planner render failure')"))
    console.log('plannerRenderFixture: built chunk passed')
  }
} finally {
  delete globalThis.window
}
console.log('plannerRenderFixture: aliased/default exports, render failure/recovery and fail-closed detection passed')
