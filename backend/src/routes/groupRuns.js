const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { validate: isUuid, v4: uuidv4 } = require('uuid');
const { dbAll, dbGet, withTransaction } = require('../db');
const auth = require('../middleware/auth');
const { cleanText } = require('../lib/profanity');
const {
  MAX_ACTIVE_OWNED_GROUP_RUNS,
  normalizeGroupRunInput,
  serializeGroupRun,
} = require('../lib/groupRunRules');

const REPORT_CATEGORIES = new Set(['harassment', 'spam', 'impersonation', 'unsafe_content', 'other']);

function userLimiter(windowMs, max, message) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `user:${req.user.id}`,
    message: { error: message },
  });
}

const createLimiter = userLimiter(60 * 60 * 1000, 5, 'Too many group run creation attempts. Try again later.');
const inviteLimiter = userLimiter(15 * 60 * 1000, 30, 'Too many group run invitations. Try again later.');
const actionLimiter = userLimiter(15 * 60 * 1000, 60, 'Too many group run changes. Try again later.');
const reportLimiter = userLimiter(24 * 60 * 60 * 1000, 10, 'Too many group run reports. Try again later.');

router.use(auth);

function groupRunUnavailable(res) {
  return res.status(404).json({ error: 'Group run not found.' });
}

async function lockUsers(tx, userIds) {
  const ids = [...new Set(userIds.map(String))].sort();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await tx.all(
    `SELECT id FROM users WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE`,
    ids
  );
  return rows.length === ids.length;
}

async function pairIsBlocked(query, firstUserId, secondUserId) {
  const row = await query.get(
    `SELECT id FROM user_blocks
     WHERE (blocker_id = ? AND blocked_id = ?)
        OR (blocker_id = ? AND blocked_id = ?)
     LIMIT 1`,
    [firstUserId, secondUserId, secondUserId, firstUserId]
  );
  return Boolean(row);
}

async function areAcceptedFriends(query, firstUserId, secondUserId) {
  const row = await query.get(
    `SELECT id FROM friendships
     WHERE status = 'accepted'
       AND ((requester_id = ? AND addressee_id = ?)
         OR (requester_id = ? AND addressee_id = ?))
     LIMIT 1`,
    [firstUserId, secondUserId, secondUserId, firstUserId]
  );
  return Boolean(row);
}

async function activeReservationCount(query, groupRunId) {
  const row = await query.get(
    `SELECT COUNT(*) AS count
     FROM group_run_members
     WHERE group_run_id = ? AND status IN ('invited', 'going')`,
    [groupRunId]
  );
  return Number(row?.count || 0);
}

router.get('/', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT gr.id, gr.title, gr.starts_at, gr.timezone, gr.duration_minutes,
              gr.run_type, gr.goal_mode, gr.target_distance_miles, gr.target_duration_minutes,
              gr.pace_note, gr.target_zone, gr.workout_structure, gr.meetup_area,
              gr.participant_limit, gr.status, gr.created_at, gr.updated_at,
              owner.name AS owner_name,
              viewer_member.status AS membership_status, viewer_member.muted,
              (gr.owner_id = ?) AS viewer_is_owner,
              (SELECT COUNT(*) FROM group_run_members going_members
               WHERE going_members.group_run_id = gr.id AND going_members.status = 'going') AS participant_count,
              (SELECT COUNT(*) FROM group_run_members reserved_members
               WHERE reserved_members.group_run_id = gr.id
                 AND reserved_members.status IN ('invited', 'going')) AS reserved_count
       FROM group_run_members viewer_member
       JOIN group_runs gr ON gr.id = viewer_member.group_run_id
       JOIN users owner ON owner.id = gr.owner_id
       WHERE viewer_member.user_id = ?
         AND viewer_member.status IN ('invited', 'going')
         AND (viewer_member.status = 'going'
           OR (gr.status = 'scheduled' AND gr.starts_at > NOW()))
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks block_pair
           WHERE (block_pair.blocker_id = gr.owner_id AND block_pair.blocked_id = ?)
              OR (block_pair.blocker_id = ? AND block_pair.blocked_id = gr.owner_id)
         )
       ORDER BY CASE WHEN viewer_member.status = 'invited' THEN 0 ELSE 1 END,
                CASE WHEN gr.status = 'scheduled' THEN 0 ELSE 1 END,
                gr.starts_at ASC, gr.created_at DESC
       LIMIT 50`,
      [req.user.id, req.user.id, req.user.id, req.user.id]
    );
    return res.json({ group_runs: rows.map((row) => serializeGroupRun(row)) });
  } catch (err) {
    console.error('[group-runs/list] failed:', err.message);
    return res.status(500).json({ error: 'Could not load group runs.' });
  }
});

router.post('/', createLimiter, async (req, res) => {
  const normalized = normalizeGroupRunInput(req.body || {}, { ownerId: req.user.id });
  if (normalized.error) return res.status(400).json({ error: normalized.error });

  const groupRunId = uuidv4();
  const groupRun = normalized.value;
  try {
    const result = await withTransaction(async (tx) => {
      const usersExist = await lockUsers(tx, [req.user.id, ...groupRun.friendIds]);
      if (!usersExist) return { status: 404, body: { error: 'Friend unavailable.' } };

      const activeOwned = await tx.get(
        `SELECT COUNT(*) AS count
         FROM group_runs
         WHERE owner_id = ? AND status = 'scheduled'
           AND starts_at + ((duration_minutes + 120) * INTERVAL '1 minute') > NOW()`,
        [req.user.id]
      );
      if (Number(activeOwned?.count || 0) >= MAX_ACTIVE_OWNED_GROUP_RUNS) {
        return { status: 409, body: { error: 'Finish or cancel an existing group run before creating another.' } };
      }

      for (const friendId of groupRun.friendIds) {
        if (!await areAcceptedFriends(tx, req.user.id, friendId)
          || await pairIsBlocked(tx, req.user.id, friendId)) {
          return { status: 404, body: { error: 'Friend unavailable.' } };
        }
      }

      await tx.run(
        `INSERT INTO group_runs (
          id, owner_id, title, starts_at, timezone, duration_minutes, run_type,
          goal_mode, target_distance_miles, target_duration_minutes, pace_note, target_zone,
          workout_structure, meetup_area, meetup_details, notes, route_json,
          participant_limit, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, 'scheduled')`,
        [
          groupRunId, req.user.id, groupRun.title, groupRun.startsAt, groupRun.timezone,
          groupRun.durationMinutes, groupRun.runType, groupRun.goalMode,
          groupRun.distanceTargetMiles, groupRun.timeTargetMinutes, groupRun.paceNote,
          groupRun.targetZone, groupRun.workoutStructure, groupRun.meetupArea,
          groupRun.meetupDetails, groupRun.notes,
          groupRun.routeJson ? JSON.stringify(groupRun.routeJson) : null,
          groupRun.participantLimit,
        ]
      );
      await tx.run(
        `INSERT INTO group_run_members (
          id, group_run_id, user_id, status, muted, invited_at, joined_at
        ) VALUES (?, ?, ?, 'going', 0, NOW(), NOW())`,
        [uuidv4(), groupRunId, req.user.id]
      );
      for (const friendId of groupRun.friendIds) {
        await tx.run(
          `INSERT INTO group_run_members (
            id, group_run_id, user_id, status, muted, invited_at, joined_at
          ) VALUES (?, ?, ?, 'invited', 0, NOW(), NULL)`,
          [uuidv4(), groupRunId, friendId]
        );
      }
      return { status: 201, body: { ok: true, group_run_id: groupRunId } };
    });

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[group-runs/create] failed:', err.message);
    return res.status(500).json({ error: 'Could not create this group run.' });
  }
});

router.post('/:id/invite', inviteLimiter, async (req, res) => {
  const friendId = String(req.body?.friend_id || '');
  if (!isUuid(req.params.id) || !isUuid(friendId) || friendId === req.user.id) {
    return res.status(400).json({ error: 'Choose a valid friend.' });
  }

  try {
    const result = await withTransaction(async (tx) => {
      const usersExist = await lockUsers(tx, [req.user.id, friendId]);
      if (!usersExist) return { status: 404, body: { error: 'Friend unavailable.' } };

      const groupRun = await tx.get(
        `SELECT gr.id, gr.participant_limit, gr.starts_at, gr.status
         FROM group_runs gr
         JOIN group_run_members owner_member ON owner_member.group_run_id = gr.id
           AND owner_member.user_id = gr.owner_id
           AND owner_member.status = 'going'
         WHERE gr.id = ? AND gr.owner_id = ?
         FOR UPDATE OF gr, owner_member`,
        [req.params.id, req.user.id]
      );
      if (!groupRun) return { status: 404, body: { error: 'Group run not found.' } };
      if (groupRun.status !== 'scheduled' || new Date(groupRun.starts_at) <= new Date()) {
        return { status: 409, body: { error: 'This group run is no longer accepting invitations.' } };
      }

      if (!await areAcceptedFriends(tx, req.user.id, friendId)
        || await pairIsBlocked(tx, req.user.id, friendId)) {
        return { status: 404, body: { error: 'Friend unavailable.' } };
      }

      const existing = await tx.get(
        `SELECT id, status FROM group_run_members
         WHERE group_run_id = ? AND user_id = ?
         FOR UPDATE`,
        [req.params.id, friendId]
      );
      if (existing?.status === 'going') {
        return { status: 409, body: { error: 'This friend is already going.' } };
      }
      if (existing?.status === 'invited') {
        return { status: 200, body: { ok: true, status: 'already_invited' } };
      }

      const reservedCount = await activeReservationCount(tx, req.params.id);
      if (reservedCount >= Number(groupRun.participant_limit)) {
        return { status: 409, body: { error: 'This group run is full.' } };
      }

      if (existing) {
        const updated = await tx.run(
          `UPDATE group_run_members
           SET status = 'invited', muted = 0, invited_at = NOW(), joined_at = NULL,
               left_at = NULL, removed_at = NULL, updated_at = NOW()
           WHERE id = ? AND group_run_id = ? AND user_id = ?
             AND status IN ('declined', 'left', 'removed')`,
          [existing.id, req.params.id, friendId]
        );
        if (updated.changes !== 1) throw new Error('Group run reinvite lost its membership guard');
      } else {
        await tx.run(
          `INSERT INTO group_run_members (
            id, group_run_id, user_id, status, muted, invited_at, joined_at
          ) VALUES (?, ?, ?, 'invited', 0, NOW(), NULL)`,
          [uuidv4(), req.params.id, friendId]
        );
      }
      return { status: 201, body: { ok: true, status: 'invited' } };
    });

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[group-runs/invite] failed:', err.message);
    return res.status(500).json({ error: 'Could not invite this friend.' });
  }
});

router.patch('/:id/membership', actionLimiter, async (req, res) => {
  const action = String(req.body?.action || '');
  if (!isUuid(req.params.id) || !['join', 'decline', 'leave', 'mute'].includes(action)) {
    return res.status(400).json({ error: 'Choose a valid group run action.' });
  }
  if (action === 'mute' && typeof req.body?.muted !== 'boolean') {
    return res.status(400).json({ error: 'Muted must be true or false.' });
  }

  try {
    const result = await withTransaction(async (tx) => {
      const row = await tx.get(
        `SELECT gr.id, gr.owner_id, gr.participant_limit, gr.starts_at, gr.status,
                viewer_member.id AS membership_id,
                viewer_member.status AS membership_status
         FROM group_runs gr
         JOIN group_run_members viewer_member ON viewer_member.group_run_id = gr.id
         WHERE gr.id = ? AND viewer_member.user_id = ?
           AND viewer_member.status IN ('invited', 'going')
           AND NOT EXISTS (
             SELECT 1 FROM user_blocks block_pair
             WHERE (block_pair.blocker_id = gr.owner_id AND block_pair.blocked_id = ?)
                OR (block_pair.blocker_id = ? AND block_pair.blocked_id = gr.owner_id)
           )
         FOR UPDATE OF gr, viewer_member`,
        [req.params.id, req.user.id, req.user.id, req.user.id]
      );
      if (!row) return { status: 404, body: { error: 'Group run not found.' } };

      if (action === 'mute') {
        const updated = await tx.run(
          `UPDATE group_run_members
           SET muted = ?, updated_at = NOW()
           WHERE id = ? AND group_run_id = ? AND user_id = ?
             AND status IN ('invited', 'going')`,
          [req.body.muted ? 1 : 0, row.membership_id, req.params.id, req.user.id]
        );
        if (updated.changes !== 1) throw new Error('Group run mute lost its user guard');
        return { status: 200, body: { ok: true, muted: req.body.muted } };
      }

      if (action === 'join') {
        if (row.membership_status !== 'invited') {
          return { status: 409, body: { error: 'This invitation is no longer available.' } };
        }
        if (row.status !== 'scheduled' || new Date(row.starts_at) <= new Date()) {
          return { status: 409, body: { error: 'This group run has already started.' } };
        }
        if (!await areAcceptedFriends(tx, row.owner_id, req.user.id)
          || await pairIsBlocked(tx, row.owner_id, req.user.id)) {
          return { status: 404, body: { error: 'Group run not found.' } };
        }
        const reservedCount = await activeReservationCount(tx, req.params.id);
        if (reservedCount > Number(row.participant_limit)) {
          return { status: 409, body: { error: 'This group run is full.' } };
        }
        const updated = await tx.run(
          `UPDATE group_run_members
           SET status = 'going', joined_at = NOW(), left_at = NULL,
               removed_at = NULL, updated_at = NOW()
           WHERE id = ? AND group_run_id = ? AND user_id = ? AND status = 'invited'`,
          [row.membership_id, req.params.id, req.user.id]
        );
        if (updated.changes !== 1) throw new Error('Group run join lost its invitation guard');
        return { status: 200, body: { ok: true, status: 'going' } };
      }

      if (action === 'decline') {
        const updated = await tx.run(
          `UPDATE group_run_members
           SET status = 'declined', left_at = NOW(), updated_at = NOW()
           WHERE id = ? AND group_run_id = ? AND user_id = ? AND status = 'invited'`,
          [row.membership_id, req.params.id, req.user.id]
        );
        if (updated.changes !== 1) {
          return { status: 409, body: { error: 'This invitation is no longer available.' } };
        }
        return { status: 200, body: { ok: true, status: 'declined' } };
      }

      if (row.owner_id === req.user.id) {
        return { status: 409, body: { error: 'Group run owners must cancel the event instead.' } };
      }
      const updated = await tx.run(
        `UPDATE group_run_members
         SET status = 'left', left_at = NOW(), updated_at = NOW()
         WHERE id = ? AND group_run_id = ? AND user_id = ? AND status = 'going'`,
        [row.membership_id, req.params.id, req.user.id]
      );
      if (updated.changes !== 1) {
        return { status: 409, body: { error: 'This membership is no longer active.' } };
      }
      return { status: 200, body: { ok: true, status: 'left' } };
    });

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[group-runs/membership] failed:', err.message);
    return res.status(500).json({ error: 'Could not update this group run membership.' });
  }
});

router.patch('/:id', actionLimiter, async (req, res) => {
  const action = String(req.body?.action || '');
  if (!isUuid(req.params.id) || !['cancel', 'complete', 'remove_member'].includes(action)) {
    return res.status(400).json({ error: 'Choose a valid owner action.' });
  }

  try {
    const result = await withTransaction(async (tx) => {
      const groupRun = await tx.get(
        `SELECT gr.id, gr.status, gr.starts_at
         FROM group_runs gr
         JOIN group_run_members owner_member ON owner_member.group_run_id = gr.id
         WHERE gr.id = ? AND gr.owner_id = ?
           AND owner_member.user_id = ? AND owner_member.status = 'going'
         FOR UPDATE OF gr, owner_member`,
        [req.params.id, req.user.id, req.user.id]
      );
      if (!groupRun) return { status: 404, body: { error: 'Group run not found.' } };
      if (groupRun.status !== 'scheduled') {
        return { status: 409, body: { error: 'This group run is no longer scheduled.' } };
      }
      if (action === 'complete' && new Date(groupRun.starts_at) > new Date()) {
        return { status: 409, body: { error: 'This group run has not started yet.' } };
      }

      if (action === 'cancel' || action === 'complete') {
        const nextStatus = action === 'cancel' ? 'cancelled' : 'completed';
        const timestampColumn = action === 'cancel' ? 'cancelled_at' : 'completed_at';
        const updated = await tx.run(
          `UPDATE group_runs
           SET status = ?, ${timestampColumn} = NOW(), updated_at = NOW()
           WHERE id = ? AND owner_id = ? AND status = 'scheduled'`,
          [nextStatus, req.params.id, req.user.id]
        );
        if (updated.changes !== 1) throw new Error('Group run owner action lost its owner guard');
        return { status: 200, body: { ok: true, status: nextStatus } };
      }

      const membershipId = String(req.body?.membership_id || '');
      if (!isUuid(membershipId)) return { status: 404, body: { error: 'Group run not found.' } };
      const target = await tx.get(
        `SELECT id, user_id
         FROM group_run_members
         WHERE id = ? AND group_run_id = ? AND user_id <> ?
           AND status IN ('invited', 'going')
         FOR UPDATE`,
        [membershipId, req.params.id, req.user.id]
      );
      if (!target) return { status: 404, body: { error: 'Group run not found.' } };

      const removed = await tx.run(
        `UPDATE group_run_members
         SET status = 'removed', left_at = NOW(), removed_at = NOW(), updated_at = NOW()
         WHERE id = ? AND group_run_id = ? AND user_id = ?
           AND status IN ('invited', 'going')`,
        [target.id, req.params.id, target.user_id]
      );
      if (removed.changes !== 1) throw new Error('Group run removal lost its user guard');
      return { status: 200, body: { ok: true, status: 'removed' } };
    });

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[group-runs/owner-action] failed:', err.message);
    return res.status(500).json({ error: 'Could not update this group run.' });
  }
});

router.post('/:id/report', reportLimiter, async (req, res) => {
  if (!isUuid(req.params.id)) return groupRunUnavailable(res);
  const category = String(req.body?.category || '');
  if (!REPORT_CATEGORIES.has(category)) {
    return res.status(400).json({ error: 'Choose a valid report reason.' });
  }
  const note = cleanText(req.body?.note).replace(/[\r\n]+/g, ' ').trim().slice(0, 500) || null;

  try {
    const result = await withTransaction(async (tx) => {
      const groupRun = await tx.get(
        `SELECT gr.id, gr.owner_id
         FROM group_runs gr
         JOIN group_run_members viewer_member ON viewer_member.group_run_id = gr.id
         WHERE gr.id = ? AND viewer_member.user_id = ?
           AND viewer_member.status IN ('invited', 'going')
           AND NOT EXISTS (
             SELECT 1 FROM user_blocks block_pair
             WHERE (block_pair.blocker_id = gr.owner_id AND block_pair.blocked_id = ?)
                OR (block_pair.blocker_id = ? AND block_pair.blocked_id = gr.owner_id)
           )
         FOR UPDATE OF gr, viewer_member`,
        [req.params.id, req.user.id, req.user.id, req.user.id]
      );
      if (!groupRun) return { status: 404, body: { error: 'Group run not found.' } };
      if (groupRun.owner_id === req.user.id) {
        return { status: 400, body: { error: 'Owners cannot report their own group run.' } };
      }
      await tx.run(
        `INSERT INTO social_reports (
          id, reporter_id, subject_user_id, category, context_type, context_id, note, status
        ) VALUES (?, ?, ?, ?, 'activity', ?, ?, 'open')`,
        [uuidv4(), req.user.id, groupRun.owner_id, category, `group_run:${req.params.id}`, note]
      );
      return { status: 201, body: { ok: true } };
    });

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[group-runs/report] failed:', err.message);
    return res.status(500).json({ error: 'Could not submit this group run report.' });
  }
});

router.get('/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return groupRunUnavailable(res);

  try {
    const groupRun = await dbGet(
      `SELECT gr.id, gr.title, gr.starts_at, gr.timezone, gr.duration_minutes,
              gr.run_type, gr.goal_mode, gr.target_distance_miles, gr.target_duration_minutes,
              gr.pace_note, gr.target_zone, gr.workout_structure, gr.meetup_area,
              CASE WHEN viewer_member.status = 'going'
                          AND gr.status <> 'cancelled'
                          AND NOW() <= gr.starts_at + ((gr.duration_minutes + 120) * INTERVAL '1 minute')
                   THEN gr.meetup_details ELSE NULL END AS meetup_details,
              CASE WHEN viewer_member.status = 'going'
                          AND gr.status <> 'cancelled'
                          AND NOW() <= gr.starts_at + ((gr.duration_minutes + 120) * INTERVAL '1 minute')
                   THEN gr.notes ELSE NULL END AS notes,
              CASE WHEN viewer_member.status = 'going'
                          AND gr.status <> 'cancelled'
                          AND NOW() <= gr.starts_at + ((gr.duration_minutes + 120) * INTERVAL '1 minute')
                   THEN gr.route_json ELSE NULL END AS route_json,
              gr.participant_limit, gr.status, gr.created_at, gr.updated_at,
              owner.name AS owner_name,
              viewer_member.status AS membership_status, viewer_member.muted,
              (gr.owner_id = ?) AS viewer_is_owner,
              (SELECT COUNT(*) FROM group_run_members going_members
               WHERE going_members.group_run_id = gr.id AND going_members.status = 'going') AS participant_count,
              (SELECT COUNT(*) FROM group_run_members reserved_members
               WHERE reserved_members.group_run_id = gr.id
                 AND reserved_members.status IN ('invited', 'going')) AS reserved_count
       FROM group_runs gr
       JOIN group_run_members viewer_member ON viewer_member.group_run_id = gr.id
       JOIN users owner ON owner.id = gr.owner_id
       WHERE gr.id = ? AND viewer_member.user_id = ?
         AND viewer_member.status IN ('invited', 'going')
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks block_pair
           WHERE (block_pair.blocker_id = gr.owner_id AND block_pair.blocked_id = ?)
              OR (block_pair.blocker_id = ? AND block_pair.blocked_id = gr.owner_id)
         )
       LIMIT 1`,
      [req.user.id, req.params.id, req.user.id, req.user.id, req.user.id]
    );
    if (!groupRun) return groupRunUnavailable(res);

    let members = [];
    if (groupRun.membership_status === 'going') {
      const memberRows = await dbAll(
        `SELECT member.id AS membership_id, athlete.name, member.status,
                (athlete.id = gr.owner_id) AS is_owner,
                (member.user_id = ?) AS is_self
         FROM group_run_members member
         JOIN group_runs gr ON gr.id = member.group_run_id
         JOIN users athlete ON athlete.id = member.user_id
         WHERE member.group_run_id = ?
           AND member.status IN ('invited', 'going')
           AND (gr.owner_id = ? OR member.status = 'going')
         ORDER BY CASE WHEN athlete.id = gr.owner_id THEN 0 ELSE 1 END,
                  member.joined_at ASC NULLS LAST, member.invited_at ASC, member.id ASC`,
        [req.user.id, req.params.id, req.user.id]
      );
      members = memberRows.map((member) => ({
        membership_id: member.membership_id,
        user: { name: member.name },
        status: member.status,
        is_owner: Boolean(member.is_owner),
        is_self: Boolean(member.is_self),
        owner_action: groupRun.viewer_is_owner && !member.is_owner
          ? { membership_id: member.membership_id }
          : null,
      }));
    }

    return res.json({
      group_run: serializeGroupRun(groupRun, { detail: true }),
      members,
    });
  } catch (err) {
    console.error('[group-runs/detail] failed:', err.message);
    return res.status(500).json({ error: 'Could not load this group run.' });
  }
});

module.exports = router;
module.exports._test = { activeReservationCount, areAcceptedFriends, pairIsBlocked };
