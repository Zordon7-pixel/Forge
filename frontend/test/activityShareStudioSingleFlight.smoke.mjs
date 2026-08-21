import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createActionSingleFlight } from '../src/lib/actionSingleFlight.js'

const studio = readFileSync(new URL('../src/components/ActivityShareStudio.jsx', import.meta.url), 'utf8')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

console.log('\n== same-tick action exclusion ==')
{
  const runAction = createActionSingleFlight()
  const nativeSave = deferred()
  const effects = { canvas: 0, nativeSave: 0 }
  let busy = false
  let status = 'previous status'
  const save = () => runAction(async () => {
    busy = true
    status = ''
    try {
      effects.canvas += 1
      await Promise.resolve()
      effects.nativeSave += 1
      await nativeSave.promise
      status = 'Saved to Photos.'
    } finally {
      busy = false
    }
  })

  const first = save()
  const second = save()
  assert.equal(await second, false, 'the second same-tick Save is rejected')
  assert.deepEqual(effects, { canvas: 1, nativeSave: 1 }, 'Save x2 performs exactly one render and one native save')
  assert.equal(status, '', 'the rejected Save does not overwrite the first action status')
  nativeSave.resolve()
  assert.equal(await first, true, 'the first Save owns the lane through completion')
  assert.equal(status, 'Saved to Photos.', 'only the accepted Save reports success')
  assert.equal(busy, false, 'Save success clears busy state')
}

{
  const runAction = createActionSingleFlight()
  const apiPost = deferred()
  const effects = { canvas: 0, apiPost: 0 }
  let status = 'previous status'
  const post = () => runAction(async () => {
    status = ''
    effects.canvas += 1
    effects.apiPost += 1
    await apiPost.promise
    status = 'Posted to your accepted friends in Forged Hybrid.'
  })

  const first = post()
  const second = post()
  assert.equal(await second, false, 'the second same-tick Post is rejected')
  assert.deepEqual(effects, { canvas: 1, apiPost: 1 }, 'Post x2 performs exactly one canvas read and one API call')
  assert.equal(status, '', 'the rejected Post does not overwrite the first action status')
  apiPost.resolve()
  assert.equal(await first, true, 'the first Post owns the lane through completion')
  assert.equal(status, 'Posted to your accepted friends in Forged Hybrid.', 'only the accepted Post reports success')
}

{
  const runAction = createActionSingleFlight()
  const nativeSave = deferred()
  const effects = { saveCanvas: 0, nativeSave: 0, postCanvas: 0, apiPost: 0 }
  let status = 'previous status'
  const save = () => runAction(async () => {
    status = ''
    effects.saveCanvas += 1
    effects.nativeSave += 1
    await nativeSave.promise
    status = 'Saved to Photos.'
  })
  const post = () => runAction(async () => {
    status = 'post started'
    effects.postCanvas += 1
    effects.apiPost += 1
  })

  const first = save()
  const second = post()
  assert.equal(await second, false, 'Post cannot enter a lane claimed by Save')
  assert.deepEqual(effects, { saveCanvas: 1, nativeSave: 1, postCanvas: 0, apiPost: 0 }, 'the rejected cross-action performs zero canvas or API side effects')
  assert.equal(status, '', 'the rejected Post cannot overwrite the Save status')
  nativeSave.resolve()
  await first
}

console.log('== release and truthful status ==')
{
  const runAction = createActionSingleFlight()
  let busy = false
  let status = 'previous status'
  let calls = 0
  const invoke = (work) => runAction(async () => {
    busy = true
    status = ''
    try {
      calls += 1
      await work()
      status = 'success'
    } catch (error) {
      if (error?.name !== 'AbortError') status = error.message
    } finally {
      busy = false
    }
  })

  assert.equal(await invoke(async () => {}), true, 'a successful action is accepted')
  assert.equal(await invoke(async () => { throw new Error('permission denied') }), true, 'the lane releases after success')
  assert.equal(status, 'permission denied', 'a failure never reports false success')
  assert.equal(busy, false, 'failure clears busy state')

  const cancelled = new Error('user cancelled')
  cancelled.name = 'AbortError'
  assert.equal(await invoke(async () => { throw cancelled }), true, 'the lane releases after failure')
  assert.equal(status, '', 'a cancellation never reports false success')
  assert.equal(busy, false, 'cancellation clears busy state')

  assert.equal(await invoke(async () => {}), true, 'the lane releases after cancellation')
  assert.equal(status, 'success', 'the next action can report its own success')
  assert.equal(await runAction(async () => {}), true, 'an early successful return releases the lane')
  assert.equal(await runAction(async () => { calls += 1 }), true, 'the next action runs after an early return')
  assert.equal(calls, 5, 'every accepted follow-up action runs exactly once')
}

console.log('== real component wiring ==')
assert.match(studio, /createActionSingleFlight/, 'the real share studio imports the synchronous gate')
assert.match(studio, /actionLaneRef\.current = createActionSingleFlight\(\)/, 'the component owns one shared action lane')
assert.equal((studio.match(/actionLaneRef\.current\(async \(\) =>/g) || []).length, 4, 'Save, Post, Share, and Copy all use the shared lane')

console.log('ACTIVITY SHARE STUDIO SINGLE-FLIGHT SMOKE OK (same-tick, cross-action, release, and status)')
