export const POST_RUN_CHECKIN_DRAFT_KEY = 'forged_hybrid_post_run_checkin_v1'

const MAX_DRAFT_AGE_MS = 24 * 60 * 60 * 1000
const PROVENANCE_VALUES = new Set(['manual', 'live_tracked', 'imported', 'unknown'])

function storageOrNull(storage) {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  return window.localStorage
}

function normalizeDraft(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const runId = typeof value.runId === 'string' && value.runId.length <= 160 ? value.runId : null
  const updatedAt = Number(value.updatedAt || value.createdAt || 0)
  if (!runId || !Number.isFinite(updatedAt) || updatedAt <= 0 || now - updatedAt > MAX_DRAFT_AGE_MS || updatedAt - now > 60_000) return null
  return {
    runId,
    createdAt: Number(value.createdAt || updatedAt),
    updatedAt,
    runQueued: Boolean(value.runQueued),
    provenance: PROVENANCE_VALUES.has(value.provenance) ? value.provenance : 'unknown',
    heatDrift: value.heatDrift && typeof value.heatDrift === 'object' ? value.heatDrift : null,
    step: Number.isInteger(Number(value.step)) ? Math.max(0, Math.min(3, Number(value.step))) : 0,
    effort: Number.isInteger(Number(value.effort)) && Number(value.effort) >= 1 && Number(value.effort) <= 10 ? Number(value.effort) : null,
    pain: ['none', 'mild', 'moderate', 'severe'].includes(value.pain) ? value.pain : null,
    energy: ['low', 'medium', 'high'].includes(value.energy) ? value.energy : null,
  }
}

export function loadPostRunCheckInDraft(runId, storage, now = Date.now()) {
  const target = storageOrNull(storage)
  if (!target) return null
  try {
    const draft = normalizeDraft(JSON.parse(target.getItem(POST_RUN_CHECKIN_DRAFT_KEY) || 'null'), now)
    if (!draft) {
      target.removeItem(POST_RUN_CHECKIN_DRAFT_KEY)
      return null
    }
    return runId && draft.runId !== String(runId) ? null : draft
  } catch (error) {
    console.error('[post-run/check-in] draft restore failed:', error?.message || error)
    target.removeItem(POST_RUN_CHECKIN_DRAFT_KEY)
    return null
  }
}

export function savePostRunCheckInDraft(value, storage, now = Date.now()) {
  const target = storageOrNull(storage)
  if (!target || !value?.runId) return null
  try {
    const existing = loadPostRunCheckInDraft(value.runId, target, now)
    const next = normalizeDraft({
      ...(existing || {}),
      ...value,
      runId: String(value.runId),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }, now)
    if (!next) return null
    target.setItem(POST_RUN_CHECKIN_DRAFT_KEY, JSON.stringify(next))
    return next
  } catch (error) {
    console.error('[post-run/check-in] draft save failed:', error?.message || error)
    return null
  }
}

export function clearPostRunCheckInDraft(runId, storage) {
  const target = storageOrNull(storage)
  if (!target) return
  try {
    const current = loadPostRunCheckInDraft(null, target)
    if (!runId || !current || current.runId === String(runId)) target.removeItem(POST_RUN_CHECKIN_DRAFT_KEY)
  } catch (error) {
    console.error('[post-run/check-in] draft clear failed:', error?.message || error)
  }
}

export default {
  loadPostRunCheckInDraft,
  savePostRunCheckInDraft,
  clearPostRunCheckInDraft,
}
