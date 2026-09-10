const { canonicalHash } = require('./racePlanPolicy');
const VERSION = 'missed-session-outcome-v1';
const REASONS = Object.freeze(['tired', 'no_time', 'didnt_feel_like_it', 'something_came_up', 'weather', 'sick']);
const MAX_RECORDS = 280; // The accepted complete-program maximum, not an activity-history limit.

function outcomeKey(date, id) { return `${date}:${id}`; }
function createMissedOutcome({ ownerId, active, session, planningDate, timezone, reason, now = new Date() }) {
  if (!REASONS.includes(reason)) throw new Error('Invalid missed-session reason');
  const content = { version: VERSION, user_id: ownerId, user_plan_id: active.user_plan_id,
    plan_id: active.plan_id || active.id, plan_revision: active.plan_version,
    session_id: session.sessionId, session_content_hash: session.contentHash,
    scheduled_local_date: session.date, recorded_phone_local_date: planningDate,
    timezone, reason, outcome: 'MISSED', disposition: 'RECORDED' };
  return { ...content, fingerprint: canonicalHash(content), created_at: new Date(now).toISOString() };
}
function missedResponse(record, replayed = false) {
  return { ok: true, outcome: 'recorded', plan_changed: false, replayed, record,
    message: 'Marked this session as missed. Your plan has not changed.' };
}
module.exports = { VERSION, REASONS, MAX_RECORDS, outcomeKey, createMissedOutcome, missedResponse };
