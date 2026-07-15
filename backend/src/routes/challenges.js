const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { validate: isUuid, v4: uuidv4 } = require('uuid');
const { dbAll, dbGet, dbRun, withTransaction } = require('../db');
const auth = require('../middleware/auth');
const { addDays, challengeTemplateLabel, effectiveChallengeStatus, normalizeChallengeInput } = require('../lib/challengeRules');
const { rankChallengeScores, scoreChallenge } = require('../lib/challengeScoring');
const { runActivitySql } = require('../lib/runActivity');

const MAX_ACTIVE_OWNED_CHALLENGES = 10;

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

const createLimiter = userLimiter(60 * 60 * 1000, 10, 'Too many challenge creation attempts. Try again later.');
const inviteLimiter = userLimiter(15 * 60 * 1000, 30, 'Too many challenge invitations. Try again later.');
const membershipLimiter = userLimiter(15 * 60 * 1000, 60, 'Too many challenge changes. Try again later.');

router.use(auth);

function challengeUnavailable(res) {
  return res.status(404).json({ error: 'Challenge not found.' });
}

function optionalNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function serializeChallenge(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || null,
    template_type: row.template_type,
    template_label: challengeTemplateLabel(row.template_type),
    start_date: row.start_date,
    end_date: row.end_date,
    timezone: row.timezone,
    verification_policy: row.verification_policy,
    participant_limit: Number(row.participant_limit || 25),
    participant_count: Number(row.participant_count || 0),
    run_target: optionalNumber(row.run_target),
    run_unit: row.run_unit || null,
    lift_target: optionalNumber(row.lift_target),
    lift_unit: row.lift_unit || null,
    status: effectiveChallengeStatus(row),
    membership: row.membership_status ? {
      role: row.membership_role,
      status: row.membership_status,
      muted: Boolean(row.notifications_muted),
      joined_at: row.membership_joined_at || null,
    } : null,
  };
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

async function getChallengeForUser(challengeId, userId, statuses = ['invited', 'joined']) {
  return dbGet(
    `SELECT c.*, uc.role AS membership_role, uc.status AS membership_status,
            uc.notifications_muted, uc.joined_at AS membership_joined_at,
            (SELECT COUNT(*) FROM user_challenges members
             WHERE members.challenge_id = c.id AND members.status = 'joined') AS participant_count
     FROM challenges c
     JOIN user_challenges uc ON uc.challenge_id = c.id
     WHERE c.id = ? AND uc.user_id = ?
       AND uc.status = ANY(?::text[])
       AND c.kind = 'social'
       AND c.visibility IN ('private', 'friends')
       AND c.status IN ('active', 'completed')
     LIMIT 1`,
    [challengeId, userId, statuses]
  );
}

async function loadScoringRows(challenge, userIds) {
  if (!userIds.length) return { runs: [], workoutSessions: [], lifts: [] };
  const queryStart = addDays(challenge.start_date, -1);
  const queryEnd = addDays(challenge.end_date, 1);
  const [runs, workoutSessions, lifts] = await Promise.all([
    dbAll(
      `SELECT r.id, r.user_id, r.date, r.type, r.distance_miles, r.duration_seconds,
              r.watch_mode, r.watch_sync_id, r.watch_activity_type, r.watch_normalized_type,
              r.health_source, r.health_source_workout_id, r.health_start_at, r.created_at
       FROM runs r
       WHERE r.user_id = ANY(?::text[])
         AND r.date BETWEEN ? AND ?
         AND ${runActivitySql('r')}`,
      [userIds, queryStart, queryEnd]
    ),
    dbAll(
      `SELECT ws.id, ws.user_id, ws.started_at, ws.ended_at
       FROM workout_sessions ws
       WHERE ws.user_id = ANY(?::text[])
         AND ws.ended_at IS NOT NULL
         AND LEFT(COALESCE(ws.started_at, ''), 10) BETWEEN ? AND ?`,
      [userIds, queryStart, queryEnd]
    ),
    dbAll(
      `SELECT l.id, l.user_id, l.date, l.notes, l.watch_sync_id,
              l.watch_activity_type, l.watch_normalized_type, l.workout_duration_seconds
       FROM lifts l
       WHERE l.user_id = ANY(?::text[])
         AND l.date BETWEEN ? AND ?`,
      [userIds, queryStart, queryEnd]
    ),
  ]);
  return { runs, workoutSessions, lifts };
}

router.get('/', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT c.*, uc.role AS membership_role, uc.status AS membership_status,
              uc.notifications_muted, uc.joined_at AS membership_joined_at,
              (SELECT COUNT(*) FROM user_challenges members
               WHERE members.challenge_id = c.id AND members.status = 'joined') AS participant_count
       FROM user_challenges uc
       JOIN challenges c ON c.id = uc.challenge_id
       WHERE uc.user_id = ?
         AND uc.status IN ('invited', 'joined')
         AND c.kind = 'social'
         AND c.visibility IN ('private', 'friends')
         AND c.status IN ('active', 'completed')
       ORDER BY CASE WHEN uc.status = 'invited' THEN 0 ELSE 1 END,
                c.start_date ASC, c.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json({ challenges: rows.map(serializeChallenge) });
  } catch (err) {
    console.error('[challenges/list] failed:', err.message);
    res.status(500).json({ error: 'Could not load challenges.' });
  }
});

router.post('/', createLimiter, async (req, res) => {
  const normalized = normalizeChallengeInput(req.body || {});
  if (normalized.error) return res.status(400).json({ error: normalized.error });

  try {
    const challengeId = uuidv4();
    const challenge = normalized.value;
    const result = await withTransaction(async (tx) => {
      const owner = await tx.get('SELECT id FROM users WHERE id = ? FOR UPDATE', [req.user.id]);
      if (!owner) return { status: 404, body: { error: 'Account not found.' } };

      const activeCount = await tx.get(
        `SELECT COUNT(*) AS count
         FROM user_challenges uc
         JOIN challenges c ON c.id = uc.challenge_id
         WHERE uc.user_id = ? AND uc.role = 'owner' AND uc.status = 'joined'
           AND c.kind = 'social' AND c.status = 'active' AND c.end_date >= ?`,
        [req.user.id, challenge.startDate]
      );
      if (Number(activeCount?.count || 0) >= MAX_ACTIVE_OWNED_CHALLENGES) {
        return { status: 409, body: { error: 'Finish or cancel an existing challenge before creating another.' } };
      }

      const targetValue = challenge.runTarget || challenge.liftTarget;
      const targetUnit = challenge.runUnit || challenge.liftUnit;
      await tx.run(
        `INSERT INTO challenges (
          id, name, description, type, target_value, unit, badge_color, is_featured, sort_order,
          start_date, end_date, is_seasonal, creator_id, kind, visibility, template_type,
          run_target, run_unit, lift_target, lift_unit, timezone, verification_policy,
          participant_limit, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 1, ?, 'social', 'private', ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          challengeId, challenge.name, challenge.description, challenge.templateType,
          targetValue, targetUnit, '#EAB308', challenge.startDate, challenge.endDate,
          req.user.id, challenge.templateType, challenge.runTarget, challenge.runUnit,
          challenge.liftTarget, challenge.liftUnit, challenge.timezone,
          challenge.verificationPolicy, challenge.participantLimit,
        ]
      );
      await tx.run(
        `INSERT INTO user_challenges (
          id, user_id, challenge_id, progress, role, status, notifications_muted,
          invited_at, joined_at, left_at, updated_at
        ) VALUES (?, ?, ?, 0, 'owner', 'joined', 0, NOW(), NOW(), NULL, NOW())`,
        [uuidv4(), req.user.id, challengeId]
      );
      return { status: 201, body: { ok: true, challenge_id: challengeId } };
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[challenges/create] failed:', err.message);
    res.status(500).json({ error: 'Could not create this challenge.' });
  }
});

router.post('/:id/invite', inviteLimiter, async (req, res) => {
  const friendId = String(req.body?.friend_id || '');
  if (!isUuid(req.params.id) || !isUuid(friendId) || friendId === req.user.id) {
    return res.status(400).json({ error: 'Choose a valid friend.' });
  }

  try {
    const result = await withTransaction(async (tx) => {
      const challenge = await tx.get(
        `SELECT c.*, owner_uc.id AS owner_membership_id
         FROM challenges c
         JOIN user_challenges owner_uc ON owner_uc.challenge_id = c.id
         WHERE c.id = ? AND c.kind = 'social'
           AND c.visibility IN ('private', 'friends')
           AND c.status = 'active'
           AND owner_uc.user_id = ? AND owner_uc.role = 'owner' AND owner_uc.status = 'joined'
         FOR UPDATE OF c, owner_uc`,
        [req.params.id, req.user.id]
      );
      if (!challenge) return { status: 404, body: { error: 'Challenge not found.' } };
      if (effectiveChallengeStatus(challenge) !== 'active') {
        return { status: 409, body: { error: 'This challenge has ended.' } };
      }
      if (!await areAcceptedFriends(tx, req.user.id, friendId) || await pairIsBlocked(tx, req.user.id, friendId)) {
        return { status: 404, body: { error: 'Friend unavailable.' } };
      }

      const existing = await tx.get(
        `SELECT id, status FROM user_challenges
         WHERE challenge_id = ? AND user_id = ?
         FOR UPDATE`,
        [req.params.id, friendId]
      );
      if (existing?.status === 'joined') {
        return { status: 409, body: { error: 'This friend already joined.' } };
      }
      if (existing?.status === 'invited') {
        return { status: 200, body: { ok: true, status: 'already_invited' } };
      }

      const memberCount = await tx.get(
        `SELECT COUNT(*) AS count FROM user_challenges
         WHERE challenge_id = ? AND status IN ('invited', 'joined')`,
        [req.params.id]
      );
      if (Number(memberCount?.count || 0) >= Number(challenge.participant_limit || 25)) {
        return { status: 409, body: { error: 'This challenge is full.' } };
      }

      if (existing) {
        const updated = await tx.run(
          `UPDATE user_challenges
           SET role = 'member', status = 'invited', notifications_muted = 0,
               invited_at = NOW(), joined_at = NULL, left_at = NULL, updated_at = NOW()
           WHERE id = ? AND challenge_id = ? AND user_id = ?
             AND status IN ('declined', 'left', 'removed')`,
          [existing.id, req.params.id, friendId]
        );
        if (updated.changes !== 1) throw new Error('Challenge reinvite lost its membership guard');
      } else {
        await tx.run(
          `INSERT INTO user_challenges (
            id, user_id, challenge_id, progress, role, status, notifications_muted,
            invited_at, joined_at, left_at, updated_at
          ) VALUES (?, ?, ?, 0, 'member', 'invited', 0, NOW(), NULL, NULL, NOW())`,
          [uuidv4(), friendId, req.params.id]
        );
      }
      return { status: 201, body: { ok: true, status: 'invited' } };
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[challenges/invite] failed:', err.message);
    res.status(500).json({ error: 'Could not invite this friend.' });
  }
});

router.patch('/:id/membership', membershipLimiter, async (req, res) => {
  const action = String(req.body?.action || '');
  if (!isUuid(req.params.id) || !['join', 'decline', 'leave', 'mute'].includes(action)) {
    return res.status(400).json({ error: 'Choose a valid challenge action.' });
  }
  if (action === 'mute' && typeof req.body?.muted !== 'boolean') {
    return res.status(400).json({ error: 'Muted must be true or false.' });
  }

  try {
    const result = await withTransaction(async (tx) => {
      const row = await tx.get(
        `SELECT c.*, uc.id AS membership_id, uc.role AS membership_role,
                uc.status AS membership_status
         FROM challenges c
         JOIN user_challenges uc ON uc.challenge_id = c.id
         WHERE c.id = ? AND c.kind = 'social'
           AND c.visibility IN ('private', 'friends')
           AND c.status IN ('active', 'completed')
           AND uc.user_id = ?
         FOR UPDATE OF c, uc`,
        [req.params.id, req.user.id]
      );
      if (!row) return { status: 404, body: { error: 'Challenge not found.' } };

      if (action === 'mute') {
        if (!['invited', 'joined'].includes(row.membership_status)) {
          return { status: 409, body: { error: 'This challenge membership is no longer active.' } };
        }
        const updated = await tx.run(
          `UPDATE user_challenges SET notifications_muted = ?, updated_at = NOW()
           WHERE id = ? AND challenge_id = ? AND user_id = ?
             AND status IN ('invited', 'joined')`,
          [req.body.muted ? 1 : 0, row.membership_id, req.params.id, req.user.id]
        );
        if (updated.changes !== 1) throw new Error('Challenge mute lost its user guard');
        return { status: 200, body: { ok: true, muted: req.body.muted } };
      }

      if (action === 'join') {
        if (row.membership_status !== 'invited') {
          return { status: 409, body: { error: 'This invitation is no longer available.' } };
        }
        if (effectiveChallengeStatus(row) !== 'active') {
          return { status: 409, body: { error: 'This challenge has ended.' } };
        }
        const owner = await tx.get(
          `SELECT user_id FROM user_challenges
           WHERE challenge_id = ? AND role = 'owner' AND status = 'joined'
           LIMIT 1 FOR UPDATE`,
          [req.params.id]
        );
        if (!owner || !await areAcceptedFriends(tx, owner.user_id, req.user.id)
          || await pairIsBlocked(tx, owner.user_id, req.user.id)) {
          return { status: 404, body: { error: 'Challenge not found.' } };
        }
        const joinedCount = await tx.get(
          `SELECT COUNT(*) AS count FROM user_challenges
           WHERE challenge_id = ? AND status = 'joined'`,
          [req.params.id]
        );
        if (Number(joinedCount?.count || 0) >= Number(row.participant_limit || 25)) {
          return { status: 409, body: { error: 'This challenge is full.' } };
        }
        const updated = await tx.run(
          `UPDATE user_challenges
           SET status = 'joined', joined_at = NOW(), left_at = NULL, updated_at = NOW()
           WHERE id = ? AND challenge_id = ? AND user_id = ? AND status = 'invited'`,
          [row.membership_id, req.params.id, req.user.id]
        );
        if (updated.changes !== 1) throw new Error('Challenge join lost its invitation guard');
        return { status: 200, body: { ok: true, status: 'joined' } };
      }

      if (action === 'decline') {
        const updated = await tx.run(
          `UPDATE user_challenges
           SET status = 'declined', left_at = NOW(), updated_at = NOW()
           WHERE id = ? AND challenge_id = ? AND user_id = ? AND status = 'invited'`,
          [row.membership_id, req.params.id, req.user.id]
        );
        if (updated.changes !== 1) return { status: 409, body: { error: 'This invitation is no longer available.' } };
        return { status: 200, body: { ok: true, status: 'declined' } };
      }

      if (row.membership_role === 'owner') {
        return { status: 409, body: { error: 'Challenge owners must cancel the challenge instead.' } };
      }
      const updated = await tx.run(
        `UPDATE user_challenges
         SET status = 'left', left_at = NOW(), updated_at = NOW()
         WHERE id = ? AND challenge_id = ? AND user_id = ?
           AND role = 'member' AND status = 'joined'`,
        [row.membership_id, req.params.id, req.user.id]
      );
      if (updated.changes !== 1) return { status: 409, body: { error: 'This membership is no longer active.' } };
      return { status: 200, body: { ok: true, status: 'left' } };
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[challenges/membership] failed:', err.message);
    res.status(500).json({ error: 'Could not update this challenge membership.' });
  }
});

router.patch('/:id', membershipLimiter, async (req, res) => {
  const action = String(req.body?.action || '');
  if (!isUuid(req.params.id) || !['cancel', 'remove_member'].includes(action)) {
    return res.status(400).json({ error: 'Choose a valid owner action.' });
  }

  try {
    if (action === 'cancel') {
      const updated = await dbRun(
        `UPDATE challenges c SET status = 'cancelled'
         WHERE c.id = ? AND c.kind = 'social' AND c.status = 'active'
           AND EXISTS (
             SELECT 1 FROM user_challenges owner_uc
             WHERE owner_uc.challenge_id = c.id
               AND owner_uc.user_id = ?
               AND owner_uc.role = 'owner'
               AND owner_uc.status = 'joined'
           )`,
        [req.params.id, req.user.id]
      );
      if (updated.changes !== 1) return challengeUnavailable(res);
      return res.json({ ok: true, status: 'cancelled' });
    }

    const memberId = String(req.body?.member_id || '');
    if (!isUuid(memberId) || memberId === req.user.id) {
      return res.status(400).json({ error: 'Choose a valid challenge member.' });
    }
    const updated = await dbRun(
      `UPDATE user_challenges target_uc
       SET status = 'removed', left_at = NOW(), updated_at = NOW()
       WHERE target_uc.challenge_id = ? AND target_uc.user_id = ?
         AND target_uc.role = 'member' AND target_uc.status IN ('invited', 'joined')
         AND EXISTS (
           SELECT 1 FROM challenges c
           WHERE c.id = target_uc.challenge_id
             AND c.kind = 'social'
             AND c.visibility IN ('private', 'friends')
             AND c.status = 'active'
         )
         AND EXISTS (
           SELECT 1 FROM user_challenges owner_uc
           WHERE owner_uc.challenge_id = target_uc.challenge_id
             AND owner_uc.user_id = ?
             AND owner_uc.role = 'owner'
             AND owner_uc.status = 'joined'
         )`,
      [req.params.id, memberId, req.user.id]
    );
    if (updated.changes !== 1) return challengeUnavailable(res);
    return res.json({ ok: true, status: 'removed' });
  } catch (err) {
    console.error('[challenges/owner-action] failed:', err.message);
    return res.status(500).json({ error: 'Could not update this challenge.' });
  }
});

router.get('/:id/leaderboard', async (req, res) => {
  if (!isUuid(req.params.id)) return challengeUnavailable(res);
  try {
    const challenge = await getChallengeForUser(req.params.id, req.user.id, ['joined']);
    if (!challenge) return challengeUnavailable(res);

    const members = await dbAll(
      `SELECT uc.user_id, u.name
       FROM user_challenges uc
       JOIN users u ON u.id = uc.user_id
       WHERE uc.challenge_id = ? AND uc.status = 'joined'
       ORDER BY uc.joined_at ASC NULLS LAST, uc.id ASC
       LIMIT 50`,
      [req.params.id]
    );
    const userIds = members.map((member) => member.user_id);
    const scoringRows = await loadScoringRows(challenge, userIds);
    const ranked = rankChallengeScores(userIds.map((userId) => scoreChallenge(challenge, scoringRows, userId)));
    const names = new Map(members.map((member) => [member.user_id, member.name]));
    const blocks = await dbAll(
      `SELECT blocker_id, blocked_id FROM user_blocks
       WHERE blocker_id = ? OR blocked_id = ?`,
      [req.user.id, req.user.id]
    );
    const hiddenUsers = new Set(blocks.map((block) => block.blocker_id === req.user.id ? block.blocked_id : block.blocker_id));
    const rows = ranked.map((entry) => {
      if (entry.user_id !== req.user.id && hiddenUsers.has(entry.user_id)) {
        return { rank: entry.rank, masked: true };
      }
      return {
        rank: entry.rank,
        masked: false,
        is_self: entry.user_id === req.user.id,
        user: { name: names.get(entry.user_id) || 'Athlete' },
        progress: {
          score: entry.score,
          percent: entry.percent,
          completed: entry.completed,
          run: entry.run,
          lift: entry.lift,
          qualifying_counts: entry.qualifying_counts,
          contributions: entry.contributions,
        },
      };
    });
    res.json({ challenge: serializeChallenge(challenge), participant_count: members.length, rows });
  } catch (err) {
    console.error('[challenges/leaderboard] failed:', err.message);
    res.status(500).json({ error: 'Could not load this leaderboard.' });
  }
});

router.get('/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return challengeUnavailable(res);
  try {
    const challenge = await getChallengeForUser(req.params.id, req.user.id);
    if (!challenge) return challengeUnavailable(res);
    let myProgress = null;
    if (challenge.membership_status === 'joined') {
      const scoringRows = await loadScoringRows(challenge, [req.user.id]);
      myProgress = scoreChallenge(challenge, scoringRows, req.user.id);
    }
    res.json({ challenge: serializeChallenge(challenge), my_progress: myProgress });
  } catch (err) {
    console.error('[challenges/detail] failed:', err.message);
    res.status(500).json({ error: 'Could not load this challenge.' });
  }
});

module.exports = router;
module.exports._test = { loadScoringRows, serializeChallenge };
