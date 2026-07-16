const { dbAll, dbGet, dbRun } = require('../db');

const WORKFLOW_STATUSES = ['new', 'assigned', 'ready_for_qa', 'reviewed', 'shipped', 'closed'];
const WORKFLOW_ASSIGNEES = ['codex', 'hermes', 'claude_qa', 'bryan'];
const HUMAN_FEEDBACK_TYPES = ['bug', 'feature_request'];
const REVIEWED_STATUSES = new Set(['reviewed', 'shipped', 'closed']);

function validationError(message) {
  const err = new Error(message);
  err.code = 'INVALID_FEEDBACK_WORKFLOW';
  return err;
}

function normalizeLimit(value, fallback = 50) {
  const parsed = Number.parseInt(value, 10);
  return Math.min(100, Math.max(1, Number.isFinite(parsed) ? parsed : fallback));
}

function parseStatuses(value, fallback = ['new', 'assigned']) {
  const requested = Array.isArray(value) ? value : String(value || '').split(',');
  const statuses = [...new Set(requested.map((item) => String(item).trim()).filter(Boolean))];
  const normalized = statuses.length ? statuses : fallback;
  if (normalized.some((status) => !WORKFLOW_STATUSES.includes(status))) {
    throw validationError('Invalid feedback status filter.');
  }
  return normalized;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function cleanOptionalText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
  return cleaned || null;
}

function normalizeWorkflowPatch(body = {}, current = {}) {
  const status = hasOwn(body, 'status') ? String(body.status || '').trim() : current.status;
  if (!WORKFLOW_STATUSES.includes(status)) throw validationError('Invalid feedback status.');

  const assigneeKey = hasOwn(body, 'assigned_to') ? 'assigned_to' : (hasOwn(body, 'assignedTo') ? 'assignedTo' : null);
  const assignedTo = assigneeKey
    ? cleanOptionalText(body[assigneeKey], 40)
    : (current.assigned_to || null);
  if (assignedTo && !WORKFLOW_ASSIGNEES.includes(assignedTo)) {
    throw validationError('Invalid feedback assignee.');
  }

  const noteKey = hasOwn(body, 'support_note') ? 'support_note' : (hasOwn(body, 'supportNote') ? 'supportNote' : null);
  const refKey = hasOwn(body, 'linked_ref') ? 'linked_ref' : (hasOwn(body, 'linkedRef') ? 'linkedRef' : null);

  return {
    status,
    assignedTo,
    supportNote: noteKey ? cleanOptionalText(body[noteKey], 1200) : (current.support_note || null),
    linkedRef: refKey ? cleanOptionalText(body[refKey], 240) : (current.linked_ref || null),
    markReviewed: REVIEWED_STATUSES.has(status),
  };
}

async function listHumanFeedback({ statuses, limit } = {}) {
  const normalizedStatuses = parseStatuses(statuses);
  const normalizedLimit = normalizeLimit(limit);
  const placeholders = normalizedStatuses.map(() => '?').join(', ');
  return dbAll(
    `SELECT f.id, LEFT(MD5(f.user_id), 8) AS user_ref, f.type, f.message, f.page,
            f.severity, f.category, f.status, f.assigned_to, f.support_note,
            f.linked_ref, f.reviewed_at, f.created_at, f.updated_at
     FROM app_feedback f
     WHERE f.type IN ('bug', 'feature_request')
       AND f.status IN (${placeholders})
     ORDER BY f.created_at ASC
     LIMIT ?`,
    [...normalizedStatuses, normalizedLimit]
  );
}

async function updateHumanFeedback(id, body = {}) {
  const current = await dbGet(
    `SELECT id, user_id, status, assigned_to, support_note, linked_ref
     FROM app_feedback
     WHERE id=? AND type IN ('bug', 'feature_request')`,
    [id]
  );
  if (!current?.user_id) return null;

  const next = normalizeWorkflowPatch(body, current);
  const result = await dbRun(
    `UPDATE app_feedback
     SET status=?, assigned_to=?, support_note=?, linked_ref=?,
         reviewed_at=CASE WHEN ?=1 THEN COALESCE(reviewed_at, CURRENT_TIMESTAMP) ELSE reviewed_at END,
         updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND user_id=?`,
    [next.status, next.assignedTo, next.supportNote, next.linkedRef, next.markReviewed ? 1 : 0, current.id, current.user_id]
  );
  if (!result.changes) return null;

  return dbGet(
    `SELECT id, LEFT(MD5(user_id), 8) AS user_ref, type, message, page, severity,
            category, status, assigned_to, support_note, linked_ref, reviewed_at,
            created_at, updated_at
     FROM app_feedback WHERE id=? AND user_id=?`,
    [current.id, current.user_id]
  );
}

async function listImageRequests({ statuses, limit } = {}) {
  const normalizedStatuses = parseStatuses(statuses);
  const normalizedLimit = normalizeLimit(limit);
  const placeholders = normalizedStatuses.map(() => '?').join(', ');
  return dbAll(
    `SELECT id, canonical_key, display_name, example_text, source, known_exercise,
            status, occurrence_count, assigned_to, support_note, linked_ref,
            first_seen_at, last_seen_at, updated_at
     FROM exercise_image_requests
     WHERE status IN (${placeholders})
     ORDER BY last_seen_at DESC
     LIMIT ?`,
    [...normalizedStatuses, normalizedLimit]
  );
}

async function updateImageRequest(id, body = {}) {
  const current = await dbGet(
    `SELECT id, status, assigned_to, support_note, linked_ref
     FROM exercise_image_requests WHERE id=?`,
    [id]
  );
  if (!current) return null;

  const next = normalizeWorkflowPatch(body, current);
  const result = await dbRun(
    `UPDATE exercise_image_requests
     SET status=?, assigned_to=?, support_note=?, linked_ref=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=?`,
    [next.status, next.assignedTo, next.supportNote, next.linkedRef, current.id]
  );
  if (!result.changes) return null;
  return dbGet('SELECT * FROM exercise_image_requests WHERE id=?', [current.id]);
}

async function feedbackSummary() {
  const human = await dbAll(
    `SELECT status, type, COUNT(*)::int AS count
     FROM app_feedback
     WHERE type IN ('bug', 'feature_request')
     GROUP BY status, type
     ORDER BY status, type`
  );
  const images = await dbAll(
    `SELECT status, COUNT(*)::int AS count
     FROM exercise_image_requests
     GROUP BY status
     ORDER BY status`
  );
  return { human, imageRequests: images };
}

module.exports = {
  WORKFLOW_ASSIGNEES,
  WORKFLOW_STATUSES,
  HUMAN_FEEDBACK_TYPES,
  feedbackSummary,
  listHumanFeedback,
  listImageRequests,
  updateHumanFeedback,
  updateImageRequest,
  _test: { cleanOptionalText, normalizeLimit, normalizeWorkflowPatch, parseStatuses },
};
