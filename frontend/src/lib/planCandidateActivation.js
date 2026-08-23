import { verifyHyroxPlanActivation } from './planActivation.js'

export const PLAN_CANDIDATE_APPLY_TIMEOUT_MS = 45000
export const PLAN_ACTIVATION_READ_TIMEOUT_MS = 15000
export const PLAN_SURFACE_RECONCILE_TIMEOUT_MS = 15000

function lifecycleError(message, code, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function assignmentId(response = {}) {
  return String(response?.user_plan?.id || '').trim()
}

function supersededAssignmentId(response = {}) {
  return String(response?.user_plan?.supersedes_user_plan_id || '').trim()
}

function hashIdentity(value) {
  return String(value || '').trim().replace(/^sha256:/, '')
}

function verifyApplicablePublicSurface(planResponse = {}, candidateHash = '') {
  const plan = planResponse?.plan?.plan_data || planResponse?.plan?.plan_json || {}
  const applicable = Number(plan?.canonical_workout_schema_version) === 1
    && Boolean(plan?.selected_candidate_hash)
    && Boolean(plan?.canonical_session_set_hash)
  if (!applicable) return { applicable: false, confirmed: true }

  const manifest = planResponse?.surface_manifest
  const identity = manifest?.identity
  const checks = {
    accepted: manifest?.schema_version === 'goal_backward_surface_manifest_v1'
      && manifest?.status === 'accepted'
      && manifest?.v24_surface_enabled === true
      && ['preview', 'on'].includes(String(manifest?.feature_mode || ''))
      && Array.isArray(manifest?.sessions)
      && manifest.sessions.length > 0,
    assignmentRevision: Number(identity?.plan_revision) === Number(planResponse?.user_plan?.plan_version),
    planRevision: Number(identity?.plan_revision) === Number(plan?.plan_revision),
    planIdentity: String(identity?.plan_id || '') === String(plan?.plan_id || ''),
    decisionIdentity: String(identity?.decision_id || '') === String(plan?.decision_id || '')
      && hashIdentity(identity?.decision_hash) === hashIdentity(plan?.decision_hash),
    candidateIdentity: hashIdentity(identity?.candidate_hash) === hashIdentity(plan?.selected_candidate_hash)
      && hashIdentity(identity?.candidate_hash) === hashIdentity(candidateHash),
    sessionSetIdentity: hashIdentity(identity?.canonical_session_set_hash)
      === hashIdentity(plan?.canonical_session_set_hash),
  }
  return {
    applicable: true,
    confirmed: Object.values(checks).every(Boolean),
    checks,
  }
}

function blockedApplicableSurfaceKey(planResponse = {}) {
  const plan = planResponse?.plan?.plan_data || planResponse?.plan?.plan_json || {}
  const verification = verifyApplicablePublicSurface(planResponse, plan?.selected_candidate_hash)
  if (!verification.applicable || verification.confirmed) return null
  const assignment = assignmentId(planResponse)
  const storedPlan = String(planResponse?.plan?.id || '').trim()
  const logicalPlan = String(plan?.plan_id || '').trim()
  const key = assignment || storedPlan || logicalPlan
  return key ? { key: `${assignment}:${storedPlan}:${logicalPlan}`, verification } : null
}

export function createSurfaceReconcileLatch() {
  return {
    key: null,
    autoAttempted: false,
    phase: 'idle',
    inFlight: null,
  }
}

export async function reconcileBlockedPlanSurface({
  api,
  planResponse,
  latch,
  manualRetry = false,
  onState = null,
  timeoutMs = PLAN_SURFACE_RECONCILE_TIMEOUT_MS,
} = {}) {
  const blocked = blockedApplicableSurfaceKey(planResponse)
  if (!blocked) {
    if (latch) {
      latch.key = null
      latch.autoAttempted = false
      latch.phase = 'idle'
      latch.inFlight = null
    }
    return { phase: 'not_applicable', response: planResponse, refetched: false }
  }
  if (!api || !latch) throw new TypeError('Surface reconciliation requires an API client and mounted latch')
  if (latch.key !== blocked.key) {
    latch.key = blocked.key
    latch.autoAttempted = false
    latch.phase = 'idle'
    latch.inFlight = null
  }
  if (latch.inFlight) return latch.inFlight
  if (manualRetry ? latch.phase !== 'retry' : latch.autoAttempted) {
    return { phase: latch.phase, response: planResponse, refetched: false }
  }
  if (!manualRetry) latch.autoAttempted = true
  const attemptKey = blocked.key
  const publish = (phase) => {
    if (latch.key !== attemptKey) return
    latch.phase = phase
    if (typeof onState === 'function') onState({ phase })
  }
  publish('recovering')

  let task
  task = (async () => {
    try {
      const reconcileResponse = await requestWithDeadline(
        ({ timeout, signal }) => api.post('/plans/my/surface-reconcile', undefined, { timeout, signal }),
        timeoutMs,
        'Plan recovery timed out.',
      )
      if (latch.key !== attemptKey) {
        return { phase: 'superseded', response: planResponse, refetched: false }
      }
      if (reconcileResponse?.data?.accepted !== true) {
        publish('review')
        return { phase: 'review', response: planResponse, refetched: false }
      }
      const refreshed = await requestWithDeadline(
        ({ timeout, signal }) => api.get('/plans/my', {
          timeout,
          signal,
          headers: { 'Cache-Control': 'no-cache' },
          params: { forge_refresh: Date.now() },
        }),
        timeoutMs,
        'The repaired plan could not be refreshed.',
      )
      const refreshedResponse = refreshed?.data || {}
      if (latch.key !== attemptKey) {
        return { phase: 'superseded', response: planResponse, refetched: true }
      }
      const refreshedPlan = refreshedResponse?.plan?.plan_data || refreshedResponse?.plan?.plan_json || {}
      const accepted = verifyApplicablePublicSurface(
        refreshedResponse,
        refreshedPlan?.selected_candidate_hash,
      )
      if (!accepted.applicable || !accepted.confirmed) {
        publish('review')
        return { phase: 'review', response: planResponse, refetched: true }
      }
      publish('accepted')
      return { phase: 'accepted', response: refreshedResponse, refetched: true }
    } catch (error) {
      const status = Number(error?.response?.status || 0)
      const phase = status === 409 || (status >= 400 && status < 500) ? 'review' : 'retry'
      publish(phase)
      return { phase, response: planResponse, refetched: false }
    }
  })()
  latch.inFlight = task
  try {
    return await task
  } finally {
    if (latch.key === attemptKey && latch.inFlight === task) latch.inFlight = null
  }
}

function isTimeout(error) {
  return error?.code === 'PLAN_APPLY_TIMEOUT'
    || error?.code === 'ECONNABORTED'
    || error?.code === 'ETIMEDOUT'
    || error?.name === 'AbortError'
}

async function requestWithDeadline(request, timeoutMs, timeoutMessage) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort()
      reject(lifecycleError(timeoutMessage, 'PLAN_APPLY_TIMEOUT'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      Promise.resolve().then(() => request({ timeout: timeoutMs, signal: controller?.signal })),
      deadline,
    ])
  } catch (error) {
    if (error?.code === 'PLAN_APPLY_TIMEOUT') throw error
    if (isTimeout(error)) throw lifecycleError(timeoutMessage, 'PLAN_APPLY_TIMEOUT', { cause: error })
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readActivePlan(api, timeoutMs) {
  const { data } = await requestWithDeadline(
    (config) => api.get('/plans/my', {
      ...config,
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      params: { forge_refresh: Date.now() },
    }),
    timeoutMs,
    'Forge timed out while confirming the active calendar.',
  )
  return data || {}
}

async function tryReadActivePlan(api, timeoutMs) {
  try {
    return { confirmed: true, response: await readActivePlan(api, timeoutMs), error: null }
  } catch (error) {
    return { confirmed: false, response: null, error }
  }
}

function ensureImmediateApplyResponse(data) {
  if (data?.queued === true || data?.offline === true) {
    throw lifecycleError(
      'Applying a reviewed plan needs a live connection and was not queued.',
      'PLAN_APPLY_OFFLINE',
    )
  }
  const userPlanId = String(data?.user_plan_id || '').trim()
  if (data?.ok !== true || !userPlanId) {
    throw lifecycleError(
      'Forge did not return the applied plan assignment identity.',
      'PLAN_APPLY_INVALID_RESPONSE',
    )
  }
  return data
}

function reconciledAssignmentId(beforeRead, afterRead) {
  if (!beforeRead.confirmed || !afterRead.confirmed) return ''
  const beforeId = assignmentId(beforeRead.response)
  const afterId = assignmentId(afterRead.response)
  if (!afterId || afterId === beforeId) return ''
  const afterSupersedes = supersededAssignmentId(afterRead.response)
  if (beforeId) return afterSupersedes === beforeId ? afterId : ''
  return afterSupersedes ? '' : afterId
}

function failureAfterReconciliation(applyError, beforeRead, afterRead) {
  const beforeId = beforeRead.confirmed ? assignmentId(beforeRead.response) : ''
  const afterId = afterRead.confirmed ? assignmentId(afterRead.response) : ''
  const priorStateConfirmed = Boolean(
    beforeRead.confirmed
    && afterRead.confirmed
    && beforeId
    && afterId
    && beforeId === afterId
  )
  const timedOut = isTimeout(applyError)
  const offline = applyError?.code === 'PLAN_APPLY_OFFLINE'

  if (priorStateConfirmed) {
    const message = timedOut
      ? 'Plan apply timed out, and Forge confirmed the prior calendar is still active. Retry the reviewed candidate.'
      : offline
        ? 'The reviewed plan was not queued. Forge confirmed the prior calendar is still active; reconnect and retry.'
        : 'Could not apply the reviewed plan. Forge confirmed the prior calendar is still active, so it is safe to retry.'
    return lifecycleError(message, timedOut ? 'PLAN_APPLY_TIMEOUT_UNCHANGED' : 'PLAN_APPLY_FAILED_UNCHANGED', {
      cause: applyError,
      priorStateConfirmed: true,
    })
  }

  return lifecycleError(
    `${applyError?.message || 'The reviewed plan did not return a final response.'} Forge could not confirm the final active calendar. Refresh before making another plan change.`,
    'PLAN_APPLY_STATE_UNKNOWN',
    { cause: applyError, priorStateConfirmed: false },
  )
}

export async function applyPlanCandidateWithActivation({
  api,
  candidateId,
  candidateHash,
  applyBindings = null,
  planningClock,
  hyroxRace = null,
  secondaryRaceId = '',
  applyTimeoutMs = PLAN_CANDIDATE_APPLY_TIMEOUT_MS,
  readTimeoutMs = PLAN_ACTIVATION_READ_TIMEOUT_MS,
} = {}) {
  const normalizedCandidateId = String(candidateId || '').trim()
  const normalizedCandidateHash = String(candidateHash || '').trim()
  if (!normalizedCandidateId || !normalizedCandidateHash) {
    throw lifecycleError('The reviewed plan is missing its apply token. Preview again.', 'PLAN_APPLY_TOKEN_MISSING')
  }
  const reviewedApplyBindings = applyBindings && typeof applyBindings === 'object'
    && !Array.isArray(applyBindings) ? applyBindings : {}

  const beforeRead = await tryReadActivePlan(api, readTimeoutMs)
  let applyData = null
  let applyError = null
  try {
    const { data } = await requestWithDeadline(
      (config) => api.post(`/plans/candidates/${encodeURIComponent(normalizedCandidateId)}/apply`, {
        ...reviewedApplyBindings,
        candidate_hash: normalizedCandidateHash,
        choice: 'train_for_target',
        ...planningClock,
      }, config),
      applyTimeoutMs,
      'Plan apply took too long. Forge stopped waiting so the screen cannot remain pending.',
    )
    applyData = ensureImmediateApplyResponse(data)
  } catch (error) {
    applyError = error
  }

  const afterRead = await tryReadActivePlan(api, readTimeoutMs)
  if (!afterRead.confirmed) {
    if (applyData) {
      throw lifecycleError(
        'Forge accepted the reviewed plan but could not confirm the active calendar. Refresh before making another plan change.',
        'PLAN_APPLY_NOT_CONFIRMED',
        { cause: afterRead.error, applyResponse: applyData },
      )
    }
    throw failureAfterReconciliation(applyError, beforeRead, afterRead)
  }

  let expectedUserPlanId = String(applyData?.user_plan_id || '').trim()
  let reconciled = false
  if (!expectedUserPlanId && applyError) {
    expectedUserPlanId = reconciledAssignmentId(beforeRead, afterRead)
    reconciled = Boolean(expectedUserPlanId)
  }
  const activation = verifyHyroxPlanActivation({
    planResponse: afterRead.response,
    expectedUserPlanId,
    hyroxRace,
    secondaryRaceId,
  })
  const publicSurface = verifyApplicablePublicSurface(afterRead.response, normalizedCandidateHash)
  const confirmedActivation = { ...activation, publicSurface }
  if (activation.confirmed && publicSurface.confirmed) {
    return {
      activation: confirmedActivation,
      activeResponse: afterRead.response,
      applyResponse: applyData,
      reconciled,
      replay: Boolean(applyData?.replay),
    }
  }

  if (applyData) {
    throw lifecycleError(
      'Forge accepted the reviewed plan but did not confirm its exact assignment, goals, and public workout surface. Refresh before making another plan change.',
      'PLAN_APPLY_NOT_CONFIRMED',
      { activation: confirmedActivation, applyResponse: applyData },
    )
  }
  throw failureAfterReconciliation(applyError, beforeRead, afterRead)
}
