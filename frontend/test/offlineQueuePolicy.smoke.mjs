import assert from 'node:assert/strict'
import fs from 'node:fs'
import { isReplayUnsafeQueuedRequest } from '../src/lib/offlineReplayPolicy.js'

const unsafe = [
  '/api/races/race-1/removal-preview',
  '/api/races/race-1/removal-apply',
  '/api/races/race-1/removal-reset',
  '/api/plans/candidates/candidate-1/apply',
  '/api/plans/adaptation/proposal-1/accept',
  'https://forge.test/api/plans/adaptation/proposal-1/keep',
]
for (const url of unsafe) {
  assert.equal(isReplayUnsafeQueuedRequest({ url, method: 'POST' }), true, `${url} is never replayed`)
}
assert.equal(isReplayUnsafeQueuedRequest({ url: '/api/check-in', method: 'POST' }), false)
assert.equal(isReplayUnsafeQueuedRequest({ url: '/api/plans/adaptation/proposal-1/accept', method: 'GET' }), false)

const queueSource = fs.readFileSync(new URL('../src/lib/offlineQueue.js', import.meta.url), 'utf8')
assert.match(queueSource, /discardedIds = list\.filter\(isReplayUnsafeQueuedRequest\)/,
  'legacy replay-unsafe entries are selected for deletion')
assert.match(queueSource, /replayable = list\.filter\(\(item\) => !isReplayUnsafeQueuedRequest\(item\)\)/,
  'legacy replay-unsafe entries are excluded before fetch')
assert.match(queueSource, /completedIds = \[\.\.\.discardedIds, \.\.\.succeededIds\]/,
  'discarded legacy entries are deleted from the durable queue')

console.log('OFFLINE QUEUE REPLAY POLICY SMOKE OK')
