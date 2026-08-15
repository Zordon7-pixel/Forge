import { Encoder, Profile } from '@garmin/fitsdk'

const METERS_PER_MILE = 1609.344
const FIT_STRING_MAX_BYTES = 254
const CANONICAL_MANIFEST_SCHEMA = 'goal_backward_surface_manifest_v1'
const CANONICAL_EXPORT_REVISION = 1
const CAPABILITIES = new Set([
  'FULLY_STRUCTURED',
  'PARTIALLY_STRUCTURED',
  'MANUAL_COMPONENTS_REQUIRED',
  'NOT_EXPORTABLE',
])
const EXECUTABILITY = new Set(['EXECUTABLE', 'RESTRICTED', 'NOT_EXECUTABLE'])
const STRUCTURED_STEP_TYPES = new Set([
  'warmup', 'run', 'interval', 'repeat', 'recovery', 'transition', 'cooldown',
])
const MANUAL_STEP_TYPES = new Set(['station', 'strength_exercise', 'mobility', 'manual_instruction'])
const NATIVE_DURATION_FIELDS = new Set(['distance_m', 'duration_s'])
const NATIVE_TARGET_FIELDS = new Set(['pace_range_s_per_km', 'heart_rate_range_bpm', 'cadence_range_spm'])
const MESG_NUM = {
  fileId: Profile.MesgNum.FILE_ID ?? 0,
  workout: Profile.MesgNum.WORKOUT ?? 26,
  workoutStep: Profile.MesgNum.WORKOUT_STEP ?? 27,
}

function canonicalError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function positiveInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 1
}

function validHash(value) {
  return /^[a-f0-9]{64}$/.test(String(value || '').replace(/^sha256:/, '').toLowerCase())
}

function manifestFrom(value = {}) {
  if (value?.schema_version === CANONICAL_MANIFEST_SCHEMA) return value
  return value?.surfaceManifest || value?.surface_manifest || value?.canonical_manifest || null
}

export function hasCanonicalManifest(value = {}) {
  return Boolean(manifestFrom(value))
}

function selectedSession(manifest, request) {
  const sessions = Array.isArray(manifest?.sessions) ? manifest.sessions : []
  const requestedId = request?.sessionId ?? request?.session_id ?? request?.identity?.session_id
  if (!requestedId && sessions.length === 1) return sessions[0]
  return sessions.find((session) => String(session?.session_id || '') === String(requestedId || '')) || null
}

function validateAcceptedManifest(manifest, session) {
  const identity = objectValue(manifest?.identity)
  const safety = objectValue(manifest?.safety)
  if (manifest?.schema_version !== CANONICAL_MANIFEST_SCHEMA
    || manifest?.status !== 'accepted'
    || manifest?.v24_surface_enabled !== true
    || !['preview', 'on'].includes(String(manifest?.feature_mode || ''))
    || !positiveInteger(manifest?.surface_revision)
    || !identity
    || !safety
    || !Array.isArray(safety.scope)
    || !Array.isArray(safety.reason_codes)
    || !session
    || Number(session?.canonical_workout_schema_version) !== 1
    || !positiveInteger(session?.session_revision)
    || !positiveInteger(session?.plan_revision)
    || String(session?.plan_id || '') !== String(identity.plan_id || '')
    || Number(session?.plan_revision) !== Number(identity.plan_revision)
    || String(session?.decision_id || '') !== String(identity.decision_id || '')
    || !Array.isArray(session?.steps)
    || !Array.isArray(session?.target_provenance)
    || !Array.isArray(session?.safety_scope)
    || !EXECUTABILITY.has(String(session?.executability || ''))
    || !objectValue(session?.capability)
    || !CAPABILITIES.has(String(session?.capability?.classification || ''))
    || !validHash(session?.content_hash)) {
    throw canonicalError(
      'CANONICAL_MANIFEST_NOT_ACCEPTED',
      'Watch and FIT exports require one accepted canonical surface manifest with matching identity and safety fields.',
    )
  }
}

function canonicalKind(session = {}) {
  const family = String(session.workout_family || '')
  if (family.startsWith('strength_')) return 'strength'
  if (family.startsWith('hyrox_') || family === 'assessment') return 'hybrid'
  if (['rest', 'mobility', 'manual_recovery'].includes(family)) return 'recovery'
  return 'run'
}

function canonicalScheduledAt(session = {}) {
  if (session.scheduled_at) return String(session.scheduled_at)
  return session.scheduled_local_date ? `${session.scheduled_local_date}T12:00:00` : new Date().toISOString()
}

export function buildAcceptedCanonicalWorkout(request = {}) {
  const manifest = manifestFrom(request)
  const session = selectedSession(manifest, request)
  validateAcceptedManifest(manifest, session)
  const exportRevision = Number(request?.exportRevision ?? request?.export_revision ?? CANONICAL_EXPORT_REVISION)
  if (!positiveInteger(exportRevision)) {
    throw canonicalError('CANONICAL_MANIFEST_NOT_ACCEPTED', 'Export revision must be a positive integer.')
  }

  const identity = {
    session_id: String(session.session_id),
    session_revision: Number(session.session_revision),
    plan_id: String(session.plan_id),
    plan_revision: Number(session.plan_revision),
    surface_revision: Number(manifest.surface_revision),
    export_revision: exportRevision,
    content_hash: String(session.content_hash).replace(/^sha256:/, '').toLowerCase(),
  }
  const safety = {
    action: String(manifest.safety.action || ''),
    scope: clone(session.safety_scope),
    reason_codes: clone(manifest.safety.reason_codes),
    executability: String(session.executability),
  }

  return {
    schemaVersion: 2,
    schema_version: 'forge_watch_fit_canonical_v1',
    source: 'forge',
    canonical: true,
    accepted_manifest: true,
    canonical_manifest: manifest,
    identity,
    session_id: identity.session_id,
    session_revision: identity.session_revision,
    plan_id: identity.plan_id,
    plan_revision: identity.plan_revision,
    surface_revision: identity.surface_revision,
    export_revision: identity.export_revision,
    content_hash: identity.content_hash,
    role: String(session.role || ''),
    workout_family: String(session.workout_family || ''),
    kind: canonicalKind(session),
    title: String(session.title || 'Forge Workout'),
    scheduledAt: canonicalScheduledAt(session),
    timezone: String(session.timezone || ''),
    activity: canonicalKind(session) === 'run' ? 'running' : 'functionalStrengthTraining',
    location: canonicalKind(session) === 'run' ? 'outdoor' : 'indoor',
    steps: clone(session.steps),
    target_provenance: clone(session.target_provenance),
    derived_totals: clone(session.derived_totals || {}),
    safety,
    executability: safety.executability,
    capability: clone(session.capability),
    canonical_capability: clone(session.capability),
    notes: [
      ...(Array.isArray(session.adjustment_criteria) ? session.adjustment_criteria : []),
      ...(Array.isArray(session.stop_criteria) ? session.stop_criteria : []),
    ].map(String).join(' '),
  }
}

export function assertCanonicalWorkoutExecutable(workout = {}) {
  if (!workout?.canonical) return workout
  if (workout.executability !== 'EXECUTABLE' || workout.safety?.action === 'FULL_REST') {
    throw canonicalError('WORKOUT_NOT_EXECUTABLE', 'This accepted canonical session is blocked by its current safety revision.')
  }
  return workout
}

function rangeValue(value) {
  if (Array.isArray(value) && value.length === 2) {
    return { minimum: Number(value[0]), maximum: Number(value[1]) }
  }
  if (objectValue(value)) {
    return { minimum: Number(value.minimum), maximum: Number(value.maximum) }
  }
  return null
}

function classificationForCanonicalStep(step = {}) {
  if (MANUAL_STEP_TYPES.has(step.type)) {
    return {
      classification: 'MANUAL_COMPONENTS_REQUIRED',
      manual_target_fields: Object.keys(objectValue(step.target) || {}),
      unsupported_target_fields: [],
    }
  }
  if (!STRUCTURED_STEP_TYPES.has(step.type)) {
    return { classification: 'NOT_EXPORTABLE', manual_target_fields: [], unsupported_target_fields: [] }
  }
  if (step.type === 'repeat') {
    const children = Array.isArray(step.children) ? step.children : []
    if (!positiveInteger(step.repeat_count) || !children.length) {
      return { classification: 'NOT_EXPORTABLE', manual_target_fields: [], unsupported_target_fields: [] }
    }
    return aggregateCapabilities(children.map(classificationForCanonicalStep))
  }

  const target = objectValue(step.target) || {}
  const targetFields = Object.keys(target).filter((field) => target[field] !== null && target[field] !== undefined)
  const durationFields = targetFields.filter((field) => NATIVE_DURATION_FIELDS.has(field))
  const nativeTargetFields = targetFields.filter((field) => NATIVE_TARGET_FIELDS.has(field))
  const manualFields = targetFields.filter((field) => !NATIVE_DURATION_FIELDS.has(field) && !NATIVE_TARGET_FIELDS.has(field))
  if (durationFields.length > 1) manualFields.push(...durationFields.slice(1))
  if (nativeTargetFields.length > 1) manualFields.push(...nativeTargetFields.slice(1))

  const invalidRange = nativeTargetFields.some((field) => {
    const range = rangeValue(target[field])
    return !range || !Number.isFinite(range.minimum) || !Number.isFinite(range.maximum)
      || range.minimum <= 0 || range.maximum < range.minimum
  })
  return {
    classification: manualFields.length || invalidRange ? 'PARTIALLY_STRUCTURED' : 'FULLY_STRUCTURED',
    manual_target_fields: [...new Set(manualFields)],
    unsupported_target_fields: invalidRange ? nativeTargetFields : [],
  }
}

function aggregateCapabilities(capabilities = []) {
  const classes = capabilities.map((entry) => entry?.classification)
  let classification = 'NOT_EXPORTABLE'
  if (classes.length && classes.every((value) => value === 'FULLY_STRUCTURED')) classification = 'FULLY_STRUCTURED'
  else if (classes.length && classes.every((value) => value === 'MANUAL_COMPONENTS_REQUIRED')) classification = 'MANUAL_COMPONENTS_REQUIRED'
  else if (classes.some((value) => value === 'FULLY_STRUCTURED' || value === 'PARTIALLY_STRUCTURED')
    && classes.some((value) => value !== 'NOT_EXPORTABLE')) classification = 'PARTIALLY_STRUCTURED'
  else if (classes.some((value) => value === 'MANUAL_COMPONENTS_REQUIRED')) classification = 'MANUAL_COMPONENTS_REQUIRED'
  return {
    classification,
    manual_target_fields: [...new Set(capabilities.flatMap((entry) => entry?.manual_target_fields || []))],
    unsupported_target_fields: [...new Set(capabilities.flatMap((entry) => entry?.unsupported_target_fields || []))],
  }
}

function disclosedClassification(actual, declared) {
  if (declared === 'NOT_EXPORTABLE') return 'NOT_EXPORTABLE'
  if (declared === 'MANUAL_COMPONENTS_REQUIRED' && actual === 'FULLY_STRUCTURED') {
    return 'MANUAL_COMPONENTS_REQUIRED'
  }
  if (declared === 'PARTIALLY_STRUCTURED' && actual === 'FULLY_STRUCTURED') return 'PARTIALLY_STRUCTURED'
  return actual
}

function flattenFitSteps(steps = [], output = [], parentStepId = null) {
  for (const step of Array.isArray(steps) ? steps : []) {
    if (step?.type === 'repeat') {
      const repeatStartIndex = output.length
      flattenFitSteps(step.children, output, step.step_id)
      output.push({
        ...clone(step),
        children: undefined,
        canonical_type: 'repeat',
        parent_step_id: parentStepId,
        repeat_start_index: repeatStartIndex,
        capability: classificationForCanonicalStep(step),
      })
      continue
    }
    output.push({
      ...clone(step),
      canonical_type: String(step?.type || ''),
      parent_step_id: parentStepId,
      capability: classificationForCanonicalStep(step),
    })
  }
  return output
}

export function buildFitWorkoutRepresentation(request = {}) {
  const canonical = request?.canonical && request?.accepted_manifest
    ? buildAcceptedCanonicalWorkout(request)
    : buildAcceptedCanonicalWorkout(request)
  const steps = flattenFitSteps(canonical.steps)
  const aggregate = aggregateCapabilities(steps.map((step) => step.capability))
  const classification = disclosedClassification(
    aggregate.classification,
    canonical.canonical_capability?.classification,
  )
  const manualComponents = steps.filter((step) => step.capability.classification !== 'FULLY_STRUCTURED').map((step) => ({
    step_id: step.step_id,
    type: step.canonical_type,
    target: clone(step.target || {}),
    classification: step.capability.classification,
    manual_target_fields: clone(step.capability.manual_target_fields || []),
  }))

  return {
    schema_version: 'forge_fit_export_v1',
    identity: clone(canonical.identity),
    role: canonical.role,
    workout_family: canonical.workout_family,
    kind: canonical.kind,
    title: canonical.title,
    canonical_steps: clone(canonical.steps),
    target_provenance: clone(canonical.target_provenance),
    safety: clone(canonical.safety),
    executability: canonical.executability,
    capability: {
      classification,
      manual_step_ids: manualComponents.map((component) => component.step_id),
      unsupported_step_ids: steps.filter((step) => step.capability.classification === 'NOT_EXPORTABLE').map((step) => step.step_id),
    },
    manual_components: manualComponents,
    steps,
  }
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function fitString(value, fallback, { exact = false } = {}) {
  const text = String(value || fallback || '').replace(/\s+/g, ' ').trim() || fallback
  if (typeof TextEncoder === 'undefined') {
    if (exact && text.length > FIT_STRING_MAX_BYTES) {
      throw canonicalError('CANONICAL_FIT_METADATA_TOO_LARGE', 'Canonical FIT metadata exceeds the exact FIT string limit.')
    }
    return text.slice(0, FIT_STRING_MAX_BYTES)
  }

  const encoder = new TextEncoder()
  if (exact && encoder.encode(text).length > FIT_STRING_MAX_BYTES) {
    throw canonicalError('CANONICAL_FIT_METADATA_TOO_LARGE', 'Canonical FIT metadata exceeds the exact FIT string limit.')
  }
  let result = ''
  for (const char of text) {
    const candidate = `${result}${char}`
    if (encoder.encode(candidate).length > FIT_STRING_MAX_BYTES) break
    result = candidate
  }
  return result || String(fallback || '').slice(0, FIT_STRING_MAX_BYTES)
}

function stepLabel(step = {}) {
  return String(step.label || step.name || step.type || 'Workout step').trim()
}

function zoneNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const direct = Number(value)
  if (Number.isFinite(direct) && direct > 0) return Math.round(direct)

  const match = String(value).match(/(?:zone|z)?\s*([1-9][0-9]?)/i)
  return match ? Number(match[1]) : null
}

function stepHeartRateZone(step = {}, workout = {}) {
  return zoneNumber(
    step.heartRateZone
      ?? step.hrZone
      ?? step.targetHeartRateZone
      ?? step.targetHrZone
      ?? workout.targets?.heartRateZone
      ?? workout.heartRateZone,
  )
}

function stepPaceSecondsPerMile(step = {}, workout = {}) {
  return positiveNumber(
    step.targetPaceSecondsPerMile
      ?? step.paceSecondsPerMile
      ?? workout.targets?.paceSecondsPerMile
      ?? workout.targetPaceSecondsPerMile,
  )
}

function legacyStepDuration(step = {}) {
  const distanceMiles = positiveNumber(step.distanceMiles)
  if (distanceMiles) {
    return {
      durationType: 'distance',
      durationValue: Math.round(distanceMiles * METERS_PER_MILE * 100),
      durationDistance: distanceMiles * METERS_PER_MILE,
    }
  }

  const durationSeconds = positiveNumber(step.durationSeconds)
  if (durationSeconds) {
    return {
      durationType: 'time',
      durationValue: Math.round(durationSeconds * 1000),
      durationTime: durationSeconds,
    }
  }

  return { durationType: 'open', durationValue: 0 }
}

function legacyStepTarget(step = {}, workout = {}) {
  const hrZone = stepHeartRateZone(step, workout)
  if (hrZone) {
    return {
      targetType: 'heartRate', targetValue: hrZone, targetHrZone: hrZone,
      customTargetValueLow: 0, customTargetValueHigh: 0,
    }
  }

  const paceSeconds = stepPaceSecondsPerMile(step, workout)
  if (paceSeconds) {
    const speedMetersPerSecond = METERS_PER_MILE / paceSeconds
    const low = speedMetersPerSecond * 0.95
    const high = speedMetersPerSecond * 1.05
    return {
      targetType: 'speed', targetValue: 0,
      customTargetValueLow: Math.round(low * 1000), customTargetValueHigh: Math.round(high * 1000),
      customTargetSpeedLow: low, customTargetSpeedHigh: high,
    }
  }

  return { targetType: 'open', targetValue: 0 }
}

function legacyStepIntensity(step = {}, workout = {}) {
  const label = stepLabel(step).toLowerCase()
  const target = legacyStepTarget(step, workout)
  if (label.startsWith('warm')) return 'warmup'
  if (label.startsWith('cool')) return 'cooldown'
  if ((step.type === 'instruction' || step.type === 'rest') && target.targetType === 'open') return 'rest'
  return 'active'
}

function legacyWorkoutStepMessage(step, index, workout) {
  return {
    messageIndex: index,
    wktStepName: fitString(stepLabel(step), `Step ${index + 1}`),
    notes: fitString(step.notes || step.description || '', ''),
    intensity: legacyStepIntensity(step, workout),
    ...legacyStepDuration(step),
    ...legacyStepTarget(step, workout),
  }
}

function canonicalStepDuration(step = {}) {
  if (step.canonical_type === 'repeat') {
    return {
      durationType: 'repeatUntilStepsCmplt',
      durationValue: Number(step.repeat_start_index),
      durationStep: Number(step.repeat_start_index),
      targetType: 'open',
      targetValue: Number(step.repeat_count),
      repeatSteps: Number(step.repeat_count),
    }
  }
  const target = objectValue(step.target) || {}
  if (positiveNumber(target.distance_m)) {
    return {
      durationType: 'distance',
      durationValue: Math.round(Number(target.distance_m) * 100),
      durationDistance: Number(target.distance_m),
    }
  }
  if (positiveNumber(target.duration_s)) {
    return {
      durationType: 'time',
      durationValue: Math.round(Number(target.duration_s) * 1000),
      durationTime: Number(target.duration_s),
    }
  }
  return { durationType: 'open', durationValue: 0 }
}

function canonicalStepTarget(step = {}) {
  if (step.canonical_type === 'repeat') return {}
  const target = objectValue(step.target) || {}
  const pace = rangeValue(target.pace_range_s_per_km)
  if (pace && pace.minimum > 0 && pace.maximum >= pace.minimum) {
    const low = 1000 / pace.maximum
    const high = 1000 / pace.minimum
    return {
      targetType: 'speed', targetValue: 0,
      customTargetValueLow: Math.round(low * 1000), customTargetValueHigh: Math.round(high * 1000),
      customTargetSpeedLow: low, customTargetSpeedHigh: high,
    }
  }
  const heartRate = rangeValue(target.heart_rate_range_bpm)
  if (heartRate && heartRate.minimum > 0 && heartRate.maximum >= heartRate.minimum) {
    return {
      targetType: 'heartRate', targetValue: 0,
      customTargetValueLow: Math.round(heartRate.minimum), customTargetValueHigh: Math.round(heartRate.maximum),
      customTargetHeartRateLow: Math.round(heartRate.minimum), customTargetHeartRateHigh: Math.round(heartRate.maximum),
    }
  }
  const cadence = rangeValue(target.cadence_range_spm)
  if (cadence && cadence.minimum > 0 && cadence.maximum >= cadence.minimum) {
    return {
      targetType: 'cadence', targetValue: 0,
      customTargetValueLow: Math.round(cadence.minimum), customTargetValueHigh: Math.round(cadence.maximum),
      customTargetCadenceLow: Math.round(cadence.minimum), customTargetCadenceHigh: Math.round(cadence.maximum),
    }
  }
  return { targetType: 'open', targetValue: 0 }
}

function canonicalStepIntensity(step = {}) {
  if (step.canonical_type === 'warmup') return 'warmup'
  if (step.canonical_type === 'cooldown') return 'cooldown'
  if (['recovery', 'transition'].includes(step.canonical_type)) return 'rest'
  return 'active'
}

function canonicalStepMetadata(step = {}) {
  const metadata = {
    step_id: step.step_id,
    type: step.canonical_type,
    order: step.order,
    ...(step.parent_step_id ? { parent_step_id: step.parent_step_id } : {}),
    ...(step.repeat_count ? { repeat_count: Number(step.repeat_count) } : {}),
    classification: step.capability.classification,
  }
  if (step.capability.classification !== 'FULLY_STRUCTURED') metadata.target = clone(step.target || {})
  return fitString(`FORGE_STEP:${JSON.stringify(metadata)}`, '', { exact: true })
}

function canonicalWorkoutStepMessage(step, index) {
  const manual = ['MANUAL_COMPONENTS_REQUIRED', 'NOT_EXPORTABLE'].includes(step.capability.classification)
  const baseLabel = step.step_id || step.canonical_type || `Step ${index + 1}`
  return {
    messageIndex: index,
    wktStepName: fitString(manual ? `Manual: ${baseLabel}` : baseLabel, `Step ${index + 1}`),
    notes: canonicalStepMetadata(step),
    intensity: canonicalStepIntensity(step),
    ...canonicalStepDuration(step),
    ...canonicalStepTarget(step),
  }
}

function encodeLegacyWorkout(normalizedWorkout = {}) {
  const steps = Array.isArray(normalizedWorkout.steps) ? normalizedWorkout.steps : []
  const encoder = new Encoder()
  encoder.onMesg(MESG_NUM.fileId, {
    type: 'workout', manufacturer: 'development', product: 1, timeCreated: new Date(),
  })
  encoder.onMesg(MESG_NUM.workout, {
    wktName: fitString(normalizedWorkout.title, 'Forge Workout'),
    sport: normalizedWorkout.kind === 'run' ? 'running' : 'training',
    numValidSteps: steps.length,
  })
  steps.forEach((step, index) => {
    encoder.onMesg(MESG_NUM.workoutStep, legacyWorkoutStepMessage(step, index, normalizedWorkout))
  })
  return encoder.close()
}

function encodeCanonicalWorkout(request = {}) {
  const representation = buildFitWorkoutRepresentation(request)
  const canonical = buildAcceptedCanonicalWorkout(request)
  assertCanonicalWorkoutExecutable(canonical)
  if (representation.capability.classification === 'NOT_EXPORTABLE') {
    throw canonicalError('WORKOUT_NOT_EXPORTABLE', 'This accepted canonical session is not exportable as a FIT workout.')
  }
  const encoder = new Encoder()
  encoder.onMesg(MESG_NUM.fileId, {
    type: 'workout', manufacturer: 'development', product: 1, timeCreated: new Date(),
  })
  encoder.onMesg(MESG_NUM.workout, {
    wktName: fitString(representation.title, 'Forge Workout'),
    wktDescription: fitString(`FORGE_META:${JSON.stringify({
      sid: representation.identity.session_id,
      sr: representation.identity.session_revision,
      pid: representation.identity.plan_id,
      pr: representation.identity.plan_revision,
      sfr: representation.identity.surface_revision,
      er: representation.identity.export_revision,
      hash: representation.identity.content_hash,
      cap: {
        FULLY_STRUCTURED: 'FULL',
        PARTIALLY_STRUCTURED: 'PARTIAL',
        MANUAL_COMPONENTS_REQUIRED: 'MANUAL',
        NOT_EXPORTABLE: 'NONE',
      }[representation.capability.classification],
    })}`, '', { exact: true }),
    sport: representation.kind === 'run' ? 'running' : 'training',
    numValidSteps: representation.steps.length,
  })
  representation.steps.forEach((step, index) => {
    encoder.onMesg(MESG_NUM.workoutStep, canonicalWorkoutStepMessage(step, index))
  })
  return encoder.close()
}

export function encodeWorkoutFit(workout = {}) {
  if (hasCanonicalManifest(workout) && manifestFrom(workout)?.v24_surface_enabled !== false) {
    return encodeCanonicalWorkout(workout)
  }
  return encodeLegacyWorkout(workout?.workout || workout)
}
