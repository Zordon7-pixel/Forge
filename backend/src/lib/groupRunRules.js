const { validate: isUuid } = require('uuid');
const { cleanText } = require('./profanity');

const MAX_ROUTE_COORDINATES = 800;
const MAX_ACTIVE_OWNED_GROUP_RUNS = 10;
const GROUP_RUN_SAFETY_RETENTION_DAYS = 30;
const GROUP_RUN_STATUSES = new Set(['scheduled', 'completed', 'cancelled']);
const GROUP_RUN_MEMBER_STATUSES = new Set(['invited', 'going', 'declined', 'left', 'removed']);
const GOAL_MODES = new Set(['distance', 'time', 'open']);
const RUN_TYPES = new Set(['social', 'easy', 'recovery', 'long', 'tempo', 'intervals', 'hills']);

const ROUTE_STRING_FIELDS = new Map([
  ['id', 100],
  ['source', 40],
  ['provider', 40],
  ['surface', 40],
]);
const ROUTE_NUMBER_FIELDS = new Set([
  'targetDistanceMiles',
  'distanceMiles',
  'durationMinutes',
  'elevationGainMeters',
  'elevationLossMeters',
  'elevationGainFeet',
  'elevationLossFeet',
  'minElevationFeet',
  'maxElevationFeet',
]);

function normalizedText(value, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const text = cleanText(value).replace(/[\r\n]+/g, ' ').trim();
  if (!text || text.length > maxLength) return null;
  return text;
}

function optionalText(value, maxLength) {
  if (value === undefined || value === null || value === '') return { value: null };
  const text = normalizedText(value, maxLength);
  return text ? { value: text } : { error: `Text must be ${maxLength} characters or fewer.` };
}

function boundedNumber(value, min, max, { integer = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  if (integer && !Number.isInteger(number)) return null;
  return integer ? number : Math.round(number * 100) / 100;
}

function isIanaTimezone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(value || '') }).format(new Date());
    return Boolean(value);
  } catch {
    return false;
  }
}

function normalizeCoordinate(raw) {
  const rawLatitude = Array.isArray(raw) ? raw[0] : raw?.lat ?? raw?.latitude;
  const rawLongitude = Array.isArray(raw) ? raw[1] : raw?.lon ?? raw?.lng ?? raw?.longitude;
  if (rawLatitude === null || rawLatitude === undefined || rawLatitude === ''
    || rawLongitude === null || rawLongitude === undefined || rawLongitude === ''
    || typeof rawLatitude === 'boolean' || typeof rawLongitude === 'boolean') return null;
  const latitude = Number(rawLatitude);
  const longitude = Number(rawLongitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  return [latitude, longitude];
}

function normalizeRouteJson(value) {
  if (value === undefined || value === null || value === '') return { value: null };

  const route = Array.isArray(value) ? { coordinates: value } : value;
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    return { error: 'Route must be a coordinate list or route object.' };
  }
  if (!Array.isArray(route.coordinates) || route.coordinates.length < 2) {
    return { error: 'Route must contain at least two coordinates.' };
  }
  if (route.coordinates.length > MAX_ROUTE_COORDINATES) {
    return { error: `Route cannot exceed ${MAX_ROUTE_COORDINATES} coordinates.` };
  }

  const coordinates = route.coordinates.map(normalizeCoordinate);
  if (coordinates.some((coordinate) => coordinate === null)) {
    return { error: 'Route contains an invalid coordinate.' };
  }

  const normalized = { coordinates };
  for (const [field, maxLength] of ROUTE_STRING_FIELDS) {
    if (route[field] === undefined || route[field] === null || route[field] === '') continue;
    const text = String(route[field]).replace(/[\r\n]+/g, ' ').trim();
    if (text && text.length <= maxLength) normalized[field] = text;
  }
  for (const field of ROUTE_NUMBER_FIELDS) {
    if (route[field] === undefined || route[field] === null || route[field] === '') continue;
    const number = Number(route[field]);
    if (Number.isFinite(number) && Math.abs(number) <= 10_000_000) normalized[field] = number;
  }

  return { value: normalized };
}

function normalizeFriendIds(value, { ownerId, participantLimit = 25 } = {}) {
  if (value === undefined || value === null) return { value: [] };
  if (!Array.isArray(value)) return { error: 'Friend invitations must be a list.' };
  if (value.length > participantLimit - 1) {
    return { error: 'Invitations exceed the participant limit.' };
  }

  const friendIds = value.map((friendId) => String(friendId || ''));
  if (friendIds.some((friendId) => !isUuid(friendId) || friendId === ownerId)) {
    return { error: 'Choose valid friends to invite.' };
  }
  if (new Set(friendIds).size !== friendIds.length) {
    return { error: 'Each friend can only be invited once.' };
  }
  return { value: friendIds };
}

function normalizeGroupRunInput(body = {}, { now = new Date(), ownerId } = {}) {
  const title = normalizedText(body.title, 80);
  if (!title || title.length < 3) return { error: 'Title must be between 3 and 80 characters.' };

  const startsAt = new Date(body.starts_at);
  const nowDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(nowDate.getTime()) || startsAt <= nowDate) {
    return { error: 'Start time must be in the future.' };
  }

  const timezone = String(body.timezone || '').trim();
  if (!isIanaTimezone(timezone)) return { error: 'Choose a valid timezone.' };

  const durationMinutes = boundedNumber(body.duration_minutes, 10, 480, { integer: true });
  if (durationMinutes === null) return { error: 'Duration must be between 10 and 480 minutes.' };

  const runType = String(body.run_type || '').trim().toLowerCase();
  if (!RUN_TYPES.has(runType)) return { error: 'Choose a valid run type.' };

  const goalMode = String(body.goal_mode || 'open').trim().toLowerCase();
  if (!GOAL_MODES.has(goalMode)) return { error: 'Goal mode must be distance, time, or open.' };

  const rawDistanceTarget = body.distance_target_miles
    ?? body.distance_target
    ?? body.target_distance_miles
    ?? body.goal_distance_miles;
  const rawTimeTarget = body.time_target_minutes
    ?? body.time_target
    ?? body.target_time_minutes
    ?? body.goal_time_minutes
    ?? body.target_duration_minutes;
  let distanceTargetMiles = null;
  let timeTargetMinutes = null;
  if (goalMode === 'distance') {
    distanceTargetMiles = boundedNumber(rawDistanceTarget, 0.1, 200);
    if (distanceTargetMiles === null || (rawTimeTarget !== undefined && rawTimeTarget !== null && rawTimeTarget !== '')) {
      return { error: 'Distance goals require a valid distance target only.' };
    }
  } else if (goalMode === 'time') {
    timeTargetMinutes = boundedNumber(rawTimeTarget, 10, 480, { integer: true });
    if (timeTargetMinutes === null || (rawDistanceTarget !== undefined && rawDistanceTarget !== null && rawDistanceTarget !== '')) {
      return { error: 'Time goals require a valid time target only.' };
    }
  } else if ((rawDistanceTarget !== undefined && rawDistanceTarget !== null && rawDistanceTarget !== '')
    || (rawTimeTarget !== undefined && rawTimeTarget !== null && rawTimeTarget !== '')) {
    return { error: 'Open runs cannot include a distance or time target.' };
  }

  const participantLimit = body.participant_limit === undefined
    ? 25
    : boundedNumber(body.participant_limit, 2, 25, { integer: true });
  if (participantLimit === null) return { error: 'Participant limit must be between 2 and 25.' };

  const meetupArea = normalizedText(body.meetup_area, 120);
  if (!meetupArea) return { error: 'Meetup area is required.' };

  const optionalFields = [
    ['paceNote', body.pace_note, 160],
    ['targetZone', body.target_zone, 40],
    ['workoutStructure', body.workout_structure, 1200],
    ['meetupDetails', body.meetup_details, 500],
    ['notes', body.notes, 1000],
  ];
  const normalizedOptional = {};
  for (const [key, rawValue, maxLength] of optionalFields) {
    const result = optionalText(rawValue, maxLength);
    if (result.error) return result;
    normalizedOptional[key] = result.value;
  }

  const routeResult = normalizeRouteJson(body.route_json ?? body.route);
  if (routeResult.error) return routeResult;
  const friendResult = normalizeFriendIds(body.friend_ids, { ownerId, participantLimit });
  if (friendResult.error) return friendResult;

  return {
    value: {
      title,
      startsAt: startsAt.toISOString(),
      timezone,
      durationMinutes,
      runType,
      goalMode,
      distanceTargetMiles,
      timeTargetMinutes,
      meetupArea,
      routeJson: routeResult.value,
      participantLimit,
      friendIds: friendResult.value,
      ...normalizedOptional,
    },
  };
}

function privateAccessExpiresAt(groupRun) {
  const startsAt = new Date(groupRun?.starts_at);
  const durationMinutes = Number(groupRun?.duration_minutes);
  if (Number.isNaN(startsAt.getTime()) || !Number.isFinite(durationMinutes)) return null;
  return new Date(startsAt.getTime() + ((durationMinutes + 120) * 60 * 1000));
}

function canExposePrivateGroupRun(groupRun, now = new Date()) {
  const membershipStatus = groupRun?.membership_status || groupRun?.membership?.status;
  const expiresAt = privateAccessExpiresAt(groupRun);
  const nowDate = now instanceof Date ? now : new Date(now);
  return membershipStatus === 'going'
    && groupRun?.status !== 'cancelled'
    && expiresAt !== null
    && !Number.isNaN(nowDate.getTime())
    && nowDate <= expiresAt;
}

async function revokeBlockedGroupRunAccess(tx, blockerId, blockedId) {
  const sharedRuns = await tx.all(
    `SELECT gr.id AS group_run_id, gr.owner_id,
            blocker_member.id AS blocker_membership_id,
            blocked_member.id AS blocked_membership_id
     FROM group_runs gr
     JOIN group_run_members blocker_member ON blocker_member.group_run_id = gr.id
       AND blocker_member.user_id = ?
       AND blocker_member.status IN ('invited', 'going')
     JOIN group_run_members blocked_member ON blocked_member.group_run_id = gr.id
       AND blocked_member.user_id = ?
       AND blocked_member.status IN ('invited', 'going')
     WHERE gr.status IN ('scheduled', 'completed')
       AND gr.starts_at + (gr.duration_minutes * INTERVAL '1 minute')
         + (?::integer * INTERVAL '1 day') >= NOW()
     ORDER BY gr.id
     FOR UPDATE OF gr, blocker_member, blocked_member`,
    [blockerId, blockedId, GROUP_RUN_SAFETY_RETENTION_DAYS]
  );

  for (const groupRun of sharedRuns) {
    if (groupRun.owner_id === blockerId) {
      const removed = await tx.run(
        `UPDATE group_run_members
         SET status = 'removed', left_at = NOW(), removed_at = NOW(), updated_at = NOW()
         WHERE id = ? AND group_run_id = ? AND user_id = ?
           AND status IN ('invited', 'going')`,
        [groupRun.blocked_membership_id, groupRun.group_run_id, blockedId]
      );
      if (removed.changes !== 1) throw new Error('Blocked group run member removal lost its user guard');
      continue;
    }

    const left = await tx.run(
      `UPDATE group_run_members
       SET status = 'left', left_at = NOW(), updated_at = NOW()
       WHERE id = ? AND group_run_id = ? AND user_id = ?
         AND status IN ('invited', 'going')`,
      [groupRun.blocker_membership_id, groupRun.group_run_id, blockerId]
    );
    if (left.changes !== 1) throw new Error('Blocking group run member leave lost its user guard');
  }
}

function optionalNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function serializeGroupRun(groupRun, { detail = false, now = new Date() } = {}) {
  const serialized = {
    id: groupRun.id,
    title: groupRun.title,
    starts_at: groupRun.starts_at,
    timezone: groupRun.timezone,
    duration_minutes: Number(groupRun.duration_minutes),
    run_type: groupRun.run_type,
    goal_mode: groupRun.goal_mode,
    target_distance_miles: optionalNumber(groupRun.target_distance_miles ?? groupRun.distance_target_miles),
    target_duration_minutes: optionalNumber(groupRun.target_duration_minutes ?? groupRun.time_target_minutes),
    pace_note: groupRun.pace_note || null,
    target_zone: groupRun.target_zone || null,
    workout_structure: groupRun.workout_structure || null,
    meetup_area: groupRun.meetup_area,
    participant_limit: Number(groupRun.participant_limit),
    participant_count: Number(groupRun.participant_count || 0),
    reserved_count: Number(groupRun.reserved_count || 0),
    status: groupRun.status,
    organizer: { name: groupRun.owner_name },
    membership: {
      status: groupRun.membership_status,
      muted: Boolean(groupRun.muted),
      is_owner: Boolean(groupRun.viewer_is_owner),
    },
    created_at: groupRun.created_at,
    updated_at: groupRun.updated_at,
  };

  if (detail && canExposePrivateGroupRun(groupRun, now)) {
    serialized.meetup_details = groupRun.meetup_details || null;
    serialized.notes = groupRun.notes || null;
    serialized.route = groupRun.route_json || null;
  }

  return serialized;
}

module.exports = {
  GOAL_MODES,
  GROUP_RUN_MEMBER_STATUSES,
  GROUP_RUN_SAFETY_RETENTION_DAYS,
  GROUP_RUN_STATUSES,
  MAX_ACTIVE_OWNED_GROUP_RUNS,
  MAX_ROUTE_COORDINATES,
  RUN_TYPES,
  canExposePrivateGroupRun,
  isIanaTimezone,
  normalizeFriendIds,
  normalizeGroupRunInput,
  normalizeRouteJson,
  privateAccessExpiresAt,
  revokeBlockedGroupRunAccess,
  serializeGroupRun,
};
