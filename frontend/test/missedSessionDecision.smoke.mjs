import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ensureRecordedMissedSession } from '../src/lib/missedSessionDecision.js'
const data = {ok:true,outcome:'recorded',plan_changed:false,record:{fingerprint:'persisted'}}
assert.deepEqual(ensureRecordedMissedSession({status:200,data}),data)
for (const result of [
  {status:202,data}, {status:200,data:{...data,queued:true}}, {status:200,data:{...data,offline:true}},
  {status:200,data:{ok:true,message:'Moved tomorrow'}}, {status:200,data:{...data,record:{}}},
  {status:200,data:{...data,plan_changed:true}},
]) assert.throws(()=>ensureRecordedMissedSession(result),/has not been saved/)
const source = fs.readFileSync(new URL('../src/components/MissedWorkoutModal.jsx',import.meta.url),'utf8')
assert.match(source,/ensureRecordedMissedSession\(res\)/)
assert.match(source,/session_content_hash: selected.contentHash/)
assert.match(source,/phonePlanningClock\(\)/)
assert.match(source,/status === 409/)
assert.doesNotMatch(source,/Moved to tomorrow|cleared your schedule|I'll adjust your plan|toISOString\(\)\.slice/)
console.log('missed session exact-record and offline truth smoke: PASS')
