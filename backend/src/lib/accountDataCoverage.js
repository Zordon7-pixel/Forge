const ACCOUNT_EXPORT_TABLES = [
  { key: 'runs', table: 'runs', orderBy: 'COALESCE(date, created_at) DESC' },
  { key: 'run_import_tombstones', table: 'run_import_tombstones', orderBy: 'created_at DESC' },
  { key: 'activity_import_claims', table: 'activity_import_claims', orderBy: 'created_at DESC' },
  { key: 'activity_measured_receipts', table: 'activity_measured_receipts', orderBy: 'created_at DESC, revision DESC, id ASC' },
  { key: 'provider_import_receipts', table: 'provider_import_receipts', orderBy: 'created_at DESC, revision DESC, id ASC' },
  { key: 'lifts', table: 'lifts', orderBy: 'COALESCE(date, created_at) DESC' },
  { key: 'workout_sessions', table: 'workout_sessions', orderBy: 'started_at DESC' },
  { key: 'workout_sets', table: 'workout_sets', orderBy: 'logged_at DESC' },
  { key: 'daily_checkins', table: 'daily_checkins', orderBy: 'checkin_date DESC' },
  { key: 'checkin_overrides', table: 'checkin_overrides', orderBy: 'date DESC' },
  { key: 'plan_adjustment_proposals', table: 'plan_adjustment_proposals', orderBy: 'created_at DESC' },
  { key: 'race_events', table: 'race_events', orderBy: 'race_date DESC' },
  { key: 'training_plans', table: 'training_plans', where: 'user_id = ?', orderBy: 'created_at DESC' },
  { key: 'user_plans', table: 'user_plans', orderBy: 'created_at DESC' },
  { key: 'plan_generation_candidates', table: 'plan_generation_candidates', orderBy: 'created_at DESC' },
  { key: 'planning_pipeline_artifacts', table: 'planning_pipeline_artifacts', orderBy: 'created_at DESC' },
  { key: 'planning_evidence_corrections', table: 'planning_evidence_corrections', orderBy: 'created_at DESC' },
  { key: 'planning_constraints', table: 'planning_constraints', orderBy: 'created_at DESC' },
  { key: 'plan_candidate_rejections', table: 'plan_candidate_rejections', orderBy: 'created_at DESC' },
  { key: 'diagnostic_access_as_target', table: 'diagnostic_access_audit', where: 'target_user_id = ?', columns: 'id, training_plan_id, user_plan_id, candidate_id, action, created_at', orderBy: 'created_at DESC' },
  { key: 'diagnostic_access_as_actor', table: 'diagnostic_access_audit', where: 'actor_user_id = ?', columns: 'id, action, created_at', orderBy: 'created_at DESC' },
  { key: 'personal_records', table: 'personal_records', orderBy: 'achieved_at DESC' },
  { key: 'injury_logs', table: 'injury_logs', orderBy: 'date DESC' },
  { key: 'pt_exercises', table: 'pt_exercises', orderBy: 'date DESC, created_at DESC' },
  { key: 'pt_milestones', table: 'pt_milestones', orderBy: 'date ASC, created_at ASC' },
  { key: 'journal_entries', table: 'journal_entries', orderBy: 'created_at DESC' },
  { key: 'gear_shoes', table: 'gear_shoes', orderBy: 'created_at DESC' },
  { key: 'ai_usage', table: 'ai_usage', orderBy: 'created_at DESC' },
  { key: 'suggested_goals', table: 'suggested_goals', orderBy: 'created_at DESC' },
  { key: 'milestones_seen', table: 'milestones_seen', orderBy: 'seen_at DESC' },
  { key: 'user_badges', table: 'user_badges', orderBy: 'earned_at DESC' },
  { key: 'user_challenges', table: 'user_challenges', orderBy: 'joined_at DESC' },
  { key: 'owned_challenges', table: 'challenges', where: "id IN (SELECT challenge_id FROM user_challenges WHERE user_id = ? AND role = 'owner')", orderBy: 'created_at DESC' },
  { key: 'owned_group_runs', table: 'group_runs', where: 'owner_id = ?', orderBy: 'starts_at DESC' },
  { key: 'group_run_memberships', table: 'group_run_members', orderBy: 'created_at DESC' },
  { key: 'step_logs', table: 'step_logs', orderBy: 'log_date DESC' },
  { key: 'activity_feed', table: 'activity_feed', orderBy: 'created_at DESC' },
  { key: 'activity_likes', table: 'activity_likes', orderBy: 'created_at DESC' },
  { key: 'activity_comments', table: 'activity_comments', orderBy: 'created_at DESC' },
  { key: 'activity_media', table: 'activity_media', columns: 'id, activity_id, activity_type, user_id, mime_type, created_at', orderBy: 'created_at DESC' },
  { key: 'follows_as_follower', table: 'follows', where: 'follower_id = ?', orderBy: 'created_at DESC' },
  { key: 'follows_as_following', table: 'follows', where: 'following_id = ?', orderBy: 'created_at DESC' },
  { key: 'friendships_requested', table: 'friendships', where: 'requester_id = ?', orderBy: 'created_at DESC' },
  { key: 'friendships_received', table: 'friendships', where: 'addressee_id = ?', orderBy: 'created_at DESC' },
  { key: 'friend_invites', table: 'friend_invites', where: 'owner_id = ?', columns: 'id, owner_id, expires_at, consumed_at, consumed_by_id, created_at', orderBy: 'created_at DESC' },
  { key: 'blocks_given', table: 'user_blocks', where: 'blocker_id = ?', orderBy: 'created_at DESC' },
  { key: 'blocks_received', table: 'user_blocks', where: 'blocked_id = ?', columns: 'id, blocked_id, created_at', orderBy: 'created_at DESC' },
  { key: 'social_reports_submitted', table: 'social_reports', where: 'reporter_id = ?', columns: 'id, reporter_id, subject_user_id, category, context_type, context_id, note, status, created_at, reviewed_at', orderBy: 'created_at DESC' },
  { key: 'community_posts', table: 'community_posts', orderBy: 'created_at DESC' },
  { key: 'community_workouts', table: 'community_workouts', orderBy: 'created_at DESC' },
  { key: 'saved_workouts', table: 'saved_workouts', orderBy: 'created_at DESC' },
  { key: 'shared_routes', table: 'shared_routes', orderBy: 'created_at DESC' },
  { key: 'route_likes', table: 'route_likes', orderBy: 'created_at DESC' },
  { key: 'app_feedback', table: 'app_feedback', columns: 'id, user_id, type, message, page, severity, category, status, created_at, updated_at', orderBy: 'created_at DESC' },
  { key: 'events', table: 'events', orderBy: 'created_at DESC' },
  { key: 'user_consents', table: 'user_consents', columns: 'id, user_id, consent_type, version, ip, created_at', orderBy: 'created_at DESC' },
  { key: 'settings', table: 'user_settings', where: "user_id = ? AND key NOT IN ('garmin_credentials')", columns: 'key, value, updated_at, created_at', orderBy: 'key ASC' },
  { key: 'watch_sync', table: 'watch_sync', orderBy: 'synced_at DESC' },
  { key: 'garmin_sleep', table: 'garmin_sleep', orderBy: 'calendar_date DESC' },
  { key: 'whoop_data', table: 'whoop_data', orderBy: 'date DESC, synced_at DESC' },
  { key: 'oura_data', table: 'oura_data', orderBy: 'date DESC, synced_at DESC' },
  { key: 'health_sync', table: 'health_sync', orderBy: 'synced_at DESC' },
  { key: 'readiness_scores', table: 'readiness_scores', orderBy: 'score_date DESC' },
  { key: 'user_hr_profile', table: 'user_hr_profile', orderBy: 'updated_at DESC' },
  { key: 'push_subscriptions', table: 'push_subscriptions', columns: 'id, user_id, created_at, active, generation, disclosure', orderBy: 'created_at DESC' },
  { key: 'strava_ingress_bindings', table: 'strava_ingress_bindings', columns: 'id, user_id, athlete_id, created_at', orderBy: 'created_at DESC' },
  { key: 'provider_event_jobs', table: 'provider_event_jobs', where: 'binding_id IN (SELECT id FROM strava_ingress_bindings WHERE user_id = ?)', columns: 'id, object_type, object_id, state, attempts, first_seen_at, updated_at', orderBy: 'first_seen_at DESC' },
  { key: 'provider_activity_links', table: 'provider_activity_links', orderBy: 'updated_at DESC' },
  { key: 'run_save_eligibility', table: 'run_save_eligibility', orderBy: 'created_at DESC' },
  { key: 'activity_notification_events', table: 'activity_notification_events', orderBy: 'created_at DESC' },
  { key: 'notification_deliveries', table: 'notification_deliveries', columns: 'id, user_id, event_id, notification_id, transport, state, attempts, created_at, accepted_at', orderBy: 'created_at DESC' },
  { key: 'user_notifications', table: 'user_notifications', orderBy: 'created_at DESC' },
  { key: 'custom_exercises', table: 'exercises', where: 'created_by_user_id = ?', columns: 'id, name, muscle_group, secondary_muscles, instructions, how_to_image_url, is_system, created_by_user_id, approved, created_at', orderBy: 'created_at DESC' },
  { key: 'strava_connection', table: 'strava_tokens', columns: 'user_id, expires_at, athlete_id, athlete_name, connected_at', orderBy: 'connected_at DESC' },
  { key: 'whoop_connection', table: 'whoop_tokens', columns: 'user_id, whoop_user_id, display_name, connected_at, updated_at', orderBy: 'connected_at DESC' },
  { key: 'oura_connection', table: 'oura_tokens', columns: 'user_id, display_name, connected_at, updated_at', orderBy: 'connected_at DESC' },
];

const ACCOUNT_SECRET_TABLES = [
  'password_reset_tokens',
  'strava_connection_fences',
  'web_push_claims', 'web_push_challenges', 'web_push_setup_operations',
];

// Their ownership is a reviewed join, not an absent user_id exemption.
const ACCOUNT_INDIRECT_OWNED_TABLES = ['provider_event_jobs', 'web_push_claims', 'web_push_setup_operations'];
const ACCOUNT_AGGREGATE_TABLES = {
  web_push_delivery_control: 'Shared delivery configuration control; no account data or export authority.',
  background_sync_control: 'Shared provider quota and activation; no account data.',
  web_push_setup_rate_buckets: 'Bounded aggregate counters; USER HMAC removed by erasePushSetupUserRate, other dimensions have no owner link.',
};

function pushSetupUserRateKey(userId, secret = process.env.WEB_PUSH_SETUP_RATE_SECRET) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new Error('Web push setup rate key is unavailable');
  }
  return require('node:crypto').createHmac('sha256', secret)
    .update('forge:web-push-setup-rate:v1:USER\0').update(String(userId)).digest();
}

async function erasePushSetupUserRate(tx, userId) {
  // No setup consumer exists in B1a. Do not demand a new deployment secret
  // merely to erase an account while the scoped counter table is empty.
  if (!await tx.get("SELECT 1 AS present FROM web_push_setup_rate_buckets WHERE dimension='USER' LIMIT 1")) return;
  await tx.run("DELETE FROM web_push_setup_rate_buckets WHERE dimension='USER' AND key_hash=?", [pushSetupUserRateKey(userId)]);
}

// Receives the authenticated owner's already-locked transaction. Neutral
// authority is not deletion-exempt: erase every owner/proof/result association
// while preserving the absence incarnation against foreign pending challenges.
async function neutralizeOwnedWebPushAuthority(tx, userId) {
  const lock = tx.dialect === 'sqlite' ? '' : ' FOR UPDATE';
  const claims = await tx.all(`SELECT c.endpoint_hash,c.incarnation,c.subscription_id
    FROM web_push_claims c JOIN push_subscriptions p ON p.id=c.subscription_id
    WHERE p.user_id=? ORDER BY c.endpoint_hash${lock ? ' FOR UPDATE OF c' : ''}`, [userId]);
  const targets = await tx.all(`SELECT id FROM push_subscriptions WHERE user_id=? ORDER BY id${lock}`, [userId]);
  const owned = new Set(targets.map(row=>row.id));
  for (const claim of claims) if (!owned.has(claim.subscription_id)) throw new Error('Web push authority changed');
  await tx.all(`SELECT id FROM web_push_challenges WHERE user_id=? ORDER BY id${lock}`, [userId]);
  await tx.all(`SELECT o.challenge_id FROM web_push_setup_operations o JOIN web_push_challenges c ON c.id=o.challenge_id
    WHERE c.user_id=? ORDER BY o.challenge_id${lock ? ' FOR UPDATE OF o' : ''}`, [userId]);
  await tx.all(`SELECT id FROM notification_deliveries WHERE user_id=? ORDER BY id${lock}`, [userId]);
  for (const claim of claims) {
    const result = await tx.run(`UPDATE web_push_claims SET state='VACANT',incarnation=?,claim_revision=0,
      proof_hash=NULL,subscription_id=NULL,last_operation_id=NULL,confirm_hash=NULL,
      updated_at=${tx.dialect === 'sqlite' ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')" : 'clock_timestamp()'}
      WHERE endpoint_hash=? AND incarnation=? AND subscription_id=? AND state='ACTIVE'
      AND subscription_id IN (SELECT id FROM push_subscriptions WHERE user_id=?)`,
    [require('node:crypto').randomUUID(),claim.endpoint_hash,claim.incarnation,claim.subscription_id,userId]);
    if (Number(result.changes)!==1) throw new Error('Web push authority changed');
  }
}

const ACCOUNT_CALLABLE_CLEANUP = Object.freeze([
  Object.freeze({table:'web_push_claims',execute:neutralizeOwnedWebPushAuthority}),
]);

const ACCOUNT_SOCIAL_DELETE_QUERIES = [
  ['DELETE FROM group_runs WHERE owner_id = ?', [0]],
  ['DELETE FROM group_run_members WHERE user_id = ?', [0]],
  ['UPDATE challenges SET creator_id = NULL WHERE creator_id = ?', [0]],
  ['UPDATE social_reports SET reporter_id = NULL, note = NULL, context_id = NULL WHERE reporter_id = ?', [0]],
  ['UPDATE social_reports SET subject_user_id = NULL, note = NULL, context_id = NULL WHERE subject_user_id = ?', [0]],
  ['DELETE FROM friend_invites WHERE owner_id = ?', [0]],
  ['DELETE FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?', [0, 0]],
  ['DELETE FROM friendships WHERE requester_id = ? OR addressee_id = ?', [0, 0]],
];

const ACCOUNT_DELETE_QUERIES = [
  ['DELETE FROM provider_event_jobs WHERE binding_id IN (SELECT id FROM strava_ingress_bindings WHERE user_id = ?)', [0]],
  ['DELETE FROM strava_ingress_bindings WHERE user_id = ?', [0]],
  ['DELETE FROM notification_deliveries WHERE user_id = ?', [0]],
  ['DELETE FROM activity_notification_events WHERE user_id = ?', [0]],
  ['DELETE FROM provider_activity_links WHERE user_id = ?', [0]],
  ['DELETE FROM run_save_eligibility WHERE user_id = ?', [0]],
  ['DELETE FROM web_push_setup_operations WHERE challenge_id IN (SELECT id FROM web_push_challenges WHERE user_id = ?)', [0]],
  ['DELETE FROM web_push_challenges WHERE user_id = ?', [0]],
  ['DELETE FROM password_reset_tokens WHERE user_id = ?', [0]],
  ['DELETE FROM push_subscriptions WHERE user_id = ?', [0]],
  ['DELETE FROM user_notifications WHERE user_id = ?', [0]],
  ['DELETE FROM ai_usage WHERE user_id = ?', [0]],
  ['DELETE FROM readiness_scores WHERE user_id = ?', [0]],
  ['DELETE FROM app_feedback WHERE user_id = ?', [0]],
  ['DELETE FROM events WHERE user_id = ?', [0]],
  ['DELETE FROM user_consents WHERE user_id = ?', [0]],
  ['DELETE FROM suggested_goals WHERE user_id = ?', [0]],
  ['DELETE FROM milestones_seen WHERE user_id = ?', [0]],
  ['DELETE FROM user_challenges WHERE user_id = ?', [0]],
  ['DELETE FROM step_logs WHERE user_id = ?', [0]],
  ['DELETE FROM user_badges WHERE user_id = ?', [0]],
  ['DELETE FROM route_likes WHERE user_id = ? OR route_id IN (SELECT id FROM shared_routes WHERE user_id = ?)', [0, 0]],
  ['DELETE FROM activity_likes WHERE user_id = ?', [0]],
  ['DELETE FROM activity_likes WHERE activity_id IN (SELECT id FROM runs WHERE user_id = ?)', [0]],
  ['DELETE FROM activity_likes WHERE activity_id IN (SELECT id FROM lifts WHERE user_id = ?)', [0]],
  ['DELETE FROM activity_likes WHERE activity_id IN (SELECT id FROM activity_feed WHERE user_id = ?)', [0]],
  ['DELETE FROM activity_likes WHERE activity_id IN (SELECT id FROM community_posts WHERE user_id = ?)', [0]],
  ['DELETE FROM activity_comments WHERE user_id = ?', [0]],
  ['DELETE FROM activity_comments WHERE activity_id IN (SELECT id FROM runs WHERE user_id = ?)', [0]],
  ['DELETE FROM activity_comments WHERE activity_id IN (SELECT id FROM lifts WHERE user_id = ?)', [0]],
  ['DELETE FROM activity_comments WHERE activity_id IN (SELECT id FROM activity_feed WHERE user_id = ?)', [0]],
  ['DELETE FROM activity_comments WHERE activity_id IN (SELECT id FROM community_posts WHERE user_id = ?)', [0]],
  ['DELETE FROM activity_media WHERE user_id = ?', [0]],
  ['DELETE FROM activity_media WHERE activity_id IN (SELECT id FROM runs WHERE user_id = ?)', [0]],
  ['DELETE FROM activity_media WHERE activity_id IN (SELECT id FROM lifts WHERE user_id = ?)', [0]],
  ['DELETE FROM activity_media WHERE activity_id IN (SELECT id FROM activity_feed WHERE user_id = ?)', [0]],
  ['DELETE FROM activity_media WHERE activity_id IN (SELECT id FROM community_posts WHERE user_id = ?)', [0]],
  ['DELETE FROM follows WHERE follower_id = ? OR following_id = ?', [0, 0]],
  ['DELETE FROM saved_workouts WHERE user_id = ?', [0]],
  ['DELETE FROM community_posts WHERE user_id = ?', [0]],
  ['DELETE FROM community_workouts WHERE user_id = ?', [0]],
  ['DELETE FROM activity_feed WHERE user_id = ?', [0]],
  ['DELETE FROM shared_routes WHERE user_id = ?', [0]],
  ['DELETE FROM journal_entries WHERE user_id = ?', [0]],
  ['DELETE FROM pt_exercises WHERE user_id = ?', [0]],
  ['DELETE FROM pt_milestones WHERE user_id = ?', [0]],
  ['DELETE FROM injury_logs WHERE user_id = ?', [0]],
  ['DELETE FROM workout_sets WHERE user_id = ?', [0]],
  ['DELETE FROM workout_sessions WHERE user_id = ?', [0]],
  ['DELETE FROM planning_pipeline_artifacts WHERE user_id = ?', [0]],
  ['DELETE FROM planning_evidence_corrections WHERE user_id = ?', [0]],
  ['DELETE FROM planning_constraints WHERE user_id = ?', [0]],
  ['DELETE FROM plan_candidate_rejections WHERE user_id = ?', [0]],
  ['DELETE FROM plan_generation_candidates WHERE user_id = ?', [0]],
  ['DELETE FROM user_plans WHERE user_id = ?', [0]],
  ['DELETE FROM training_plans WHERE user_id = ?', [0]],
  ['DELETE FROM whoop_data WHERE user_id = ?', [0]],
  ['DELETE FROM whoop_tokens WHERE user_id = ?', [0]],
  ['DELETE FROM oura_data WHERE user_id = ?', [0]],
  ['DELETE FROM oura_tokens WHERE user_id = ?', [0]],
  ['DELETE FROM strava_tokens WHERE user_id = ?', [0]],
  ['DELETE FROM strava_connection_fences WHERE user_id = ?', [0]],
  ['DELETE FROM garmin_sleep WHERE user_id = ?', [0]],
  ['DELETE FROM watch_sync WHERE user_id = ?', [0]],
  ['DELETE FROM health_sync WHERE user_id = ?', [0]],
  ['DELETE FROM user_hr_profile WHERE user_id = ?', [0]],
  ['DELETE FROM run_import_tombstones WHERE user_id = ?', [0]],
  ['DELETE FROM activity_import_claims WHERE user_id = ?', [0]],
  ['DELETE FROM activity_measured_receipts WHERE user_id = ?', [0]],
  ['DELETE FROM provider_import_receipts WHERE user_id = ?', [0]],
  ['DELETE FROM lifts WHERE user_id = ?', [0]],
  ['DELETE FROM runs WHERE user_id = ?', [0]],
  ['DELETE FROM personal_records WHERE user_id = ?', [0]],
  ['DELETE FROM daily_checkins WHERE user_id = ?', [0]],
  ['DELETE FROM checkin_overrides WHERE user_id = ?', [0]],
  ['DELETE FROM plan_adjustment_proposals WHERE user_id = ?', [0]],
  ['DELETE FROM race_events WHERE user_id = ?', [0]],
  ['DELETE FROM gear_shoes WHERE user_id = ?', [0]],
  ['DELETE FROM exercises WHERE created_by_user_id = ?', [0]],
  ['DELETE FROM user_settings WHERE user_id = ?', [0]],
];

function bindUserId(params, userId) {
  return params.map(() => userId);
}

function buildExportSql({ table, columns = '*', where = 'user_id = ?', orderBy }) {
  return `SELECT ${columns} FROM ${table} WHERE ${where}${orderBy ? ` ORDER BY ${orderBy}` : ''}`;
}

module.exports = {
  ACCOUNT_EXPORT_TABLES,
  ACCOUNT_SECRET_TABLES,
  ACCOUNT_INDIRECT_OWNED_TABLES,
  ACCOUNT_AGGREGATE_TABLES,
  ACCOUNT_SOCIAL_DELETE_QUERIES,
  ACCOUNT_DELETE_QUERIES,
  ACCOUNT_CALLABLE_CLEANUP,
  bindUserId,
  buildExportSql,
  pushSetupUserRateKey,
  erasePushSetupUserRate,
  neutralizeOwnedWebPushAuthority,
};
