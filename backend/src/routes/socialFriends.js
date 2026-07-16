const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { validate: isUuid, v4: uuidv4 } = require('uuid');
const { dbAll, dbGet, dbRun, withTransaction } = require('../db');
const auth = require('../middleware/auth');
const { cleanText } = require('../lib/profanity');
const { revokeBlockedGroupRunAccess } = require('../lib/groupRunRules');
const {
  INVITE_TTL_MS,
  MAX_ACTIVE_INVITES,
  MAX_FRIENDS,
  boundedText,
  canonicalPair,
  createInviteToken,
  hashInviteToken,
  isInviteTokenShape,
  normalizeFriendHandle,
  relationshipState,
} = require('../lib/friendship');

const REPORT_CATEGORIES = new Set(['harassment', 'spam', 'impersonation', 'unsafe_content', 'other']);
const REPORT_CONTEXTS = new Set(['profile', 'friendship']);

function limiter(windowMs, max, message) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
  });
}

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

const inviteCreateLimiter = limiter(60 * 60 * 1000, 10, 'Too many invite attempts. Try again later.');
const inviteResolveLimiter = limiter(15 * 60 * 1000, 30, 'Too many invite attempts. Try again later.');
const relationshipLimiter = limiter(15 * 60 * 1000, 60, 'Too many friend changes. Try again later.');
const reportLimiter = limiter(24 * 60 * 60 * 1000, 10, 'Too many reports. Try again later.');
const handleUpdateLimiter = userLimiter(60 * 60 * 1000, 10, 'Too many handle changes. Try again later.');
const friendSearchLimiter = userLimiter(15 * 60 * 1000, 40, 'Too many searches. Try again later.');
const directRequestLimiter = userLimiter(15 * 60 * 1000, 20, 'Too many friend requests. Try again later.');

router.use(auth);

function inviteUnavailable(res) {
  return res.status(404).json({ error: 'Invite unavailable.' });
}

function athleteUnavailable(res) {
  return res.status(404).json({ error: 'Athlete not found.' });
}

async function lockUsers(tx, userIds) {
  const ids = [...new Set(userIds.map(String))].sort();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await tx.all(`SELECT id FROM users WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE`, ids);
  return rows.length === ids.length;
}

async function acceptedFriendCount(tx, userId) {
  const row = await tx.get(
    `SELECT COUNT(*) AS count
     FROM friendships
     WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)`,
    [userId, userId]
  );
  return Number(row?.count || 0);
}

async function pairIsBlocked(tx, firstUserId, secondUserId) {
  const row = await tx.get(
    `SELECT id FROM user_blocks
     WHERE (blocker_id = ? AND blocked_id = ?)
        OR (blocker_id = ? AND blocked_id = ?)
     LIMIT 1`,
    [firstUserId, secondUserId, secondUserId, firstUserId]
  );
  return Boolean(row);
}

async function createFriendshipRequest(tx, requesterId, addresseeId) {
  if (await pairIsBlocked(tx, requesterId, addresseeId)) return { unavailable: true };

  const [userLowId, userHighId] = canonicalPair(requesterId, addresseeId);
  const existing = await tx.get(
    `SELECT id, status, requester_id, addressee_id
     FROM friendships
     WHERE user_low_id = ? AND user_high_id = ?
     FOR UPDATE`,
    [userLowId, userHighId]
  );

  if (existing?.status === 'accepted') {
    return {
      status: 200,
      body: { ok: true, friendship_id: existing.id, status: 'already_friends', direction: 'friends' },
      createdRequest: false,
    };
  }
  if (existing?.status === 'pending') {
    return {
      status: 200,
      body: {
        ok: true,
        friendship_id: existing.id,
        status: 'request_exists',
        direction: relationshipState(existing, requesterId),
      },
      createdRequest: false,
    };
  }

  const requesterCount = await acceptedFriendCount(tx, requesterId);
  const addresseeCount = await acceptedFriendCount(tx, addresseeId);
  if (requesterCount >= MAX_FRIENDS || addresseeCount >= MAX_FRIENDS) {
    return { status: 409, body: { error: 'One of these accounts has reached the friend limit.' }, createdRequest: false };
  }

  const friendshipId = existing?.id || uuidv4();
  if (existing) {
    const update = await tx.run(
      `UPDATE friendships
       SET requester_id = ?, addressee_id = ?, status = 'pending', responded_at = NULL, updated_at = NOW()
       WHERE id = ? AND user_low_id = ? AND user_high_id = ?
         AND (requester_id = ? OR addressee_id = ?)`,
      [requesterId, addresseeId, existing.id, userLowId, userHighId, requesterId, requesterId]
    );
    if (update.changes !== 1) throw new Error('Friendship reset lost its ownership guard');
  } else {
    await tx.run(
      `INSERT INTO friendships
       (id, requester_id, addressee_id, user_low_id, user_high_id, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [friendshipId, requesterId, addresseeId, userLowId, userHighId]
    );
  }

  return {
    status: 200,
    body: { ok: true, friendship_id: friendshipId, status: 'pending', direction: 'outgoing' },
    createdRequest: true,
  };
}

async function findDiscoverableAthlete(query, handle, viewerId) {
  return query.get(
    `SELECT u.id, u.name, u.friend_handle
     FROM users u
     WHERE LOWER(u.friend_handle) = ?
       AND u.friend_discoverable = 1
       AND u.id <> ?
       AND NOT EXISTS (
         SELECT 1 FROM user_blocks b
         WHERE (b.blocker_id = ? AND b.blocked_id = u.id)
            OR (b.blocker_id = u.id AND b.blocked_id = ?)
       )
     LIMIT 1`,
    [handle, viewerId, viewerId, viewerId]
  );
}

router.put('/friend-discovery-profile', handleUpdateLimiter, async (req, res) => {
  const rawHandle = req.body?.handle;
  const discoverable = req.body?.discoverable;
  if (typeof rawHandle !== 'string' || typeof discoverable !== 'boolean') {
    return res.status(400).json({ error: 'Handle and visibility are required.' });
  }

  const trimmed = rawHandle.trim().replace(/^@/, '');
  const handle = trimmed ? normalizeFriendHandle(rawHandle) : null;
  if (trimmed && !handle) {
    return res.status(400).json({ error: 'Use 3-24 letters, numbers, periods, or underscores.' });
  }

  try {
    const result = await dbRun(
      `UPDATE users
       SET friend_handle = ?, friend_discoverable = ?
       WHERE id = ?`,
      [handle, handle && discoverable ? 1 : 0, req.user.id]
    );
    if (result.changes !== 1) return res.status(404).json({ error: 'Account not found.' });
    return res.json({ handle, discoverable: Boolean(handle && discoverable) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That handle is not available.' });
    console.error('[social/friend-discovery-profile] update failed:', err.message);
    return res.status(500).json({ error: 'Could not update your friend handle.' });
  }
});

router.post('/friend-search', friendSearchLimiter, async (req, res) => {
  const handle = normalizeFriendHandle(req.body?.handle);
  if (!handle) return athleteUnavailable(res);

  try {
    const athlete = await findDiscoverableAthlete({ get: dbGet }, handle, req.user.id);
    if (!athlete) return athleteUnavailable(res);
    const [userLowId, userHighId] = canonicalPair(req.user.id, athlete.id);
    const relationship = await dbGet(
      `SELECT id, status, requester_id, addressee_id
       FROM friendships
       WHERE user_low_id = ? AND user_high_id = ?
         AND (requester_id = ? OR addressee_id = ?)
       LIMIT 1`,
      [userLowId, userHighId, req.user.id, req.user.id]
    );
    return res.json({
      athlete: {
        name: athlete.name,
        handle: athlete.friend_handle,
        relationship: relationshipState(relationship, req.user.id),
      },
    });
  } catch (err) {
    console.error('[social/friend-search] failed:', err.message);
    return res.status(500).json({ error: 'Could not search for that athlete.' });
  }
});

router.post('/friend-requests', directRequestLimiter, async (req, res) => {
  const handle = normalizeFriendHandle(req.body?.handle);
  if (!handle) return athleteUnavailable(res);

  try {
    const result = await withTransaction(async (tx) => {
      const preview = await findDiscoverableAthlete(tx, handle, req.user.id);
      if (!preview) return { unavailable: true };
      const usersExist = await lockUsers(tx, [req.user.id, preview.id]);
      if (!usersExist) return { unavailable: true };
      const athlete = await findDiscoverableAthlete(tx, handle, req.user.id);
      if (!athlete || athlete.id !== preview.id) return { unavailable: true };
      return createFriendshipRequest(tx, req.user.id, athlete.id);
    });

    if (result.unavailable) return athleteUnavailable(res);
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[social/friend-requests] create failed:', err.message);
    return res.status(500).json({ error: 'Could not send this friend request.' });
  }
});

router.post('/friend-invites', inviteCreateLimiter, async (req, res) => {
  try {
    const result = await withTransaction(async (tx) => {
      const owner = await tx.get('SELECT id FROM users WHERE id = ? FOR UPDATE', [req.user.id]);
      if (!owner) return { status: 404, body: { error: 'Account not found.' } };

      if (await acceptedFriendCount(tx, req.user.id) >= MAX_FRIENDS) {
        return { status: 409, body: { error: 'Friend limit reached.' } };
      }

      const activeRow = await tx.get(
        `SELECT COUNT(*) AS count FROM friend_invites
         WHERE owner_id = ? AND consumed_at IS NULL AND expires_at > NOW()`,
        [req.user.id]
      );
      if (Number(activeRow?.count || 0) >= MAX_ACTIVE_INVITES) {
        return { status: 409, body: { error: 'You already have five active invites.' } };
      }

      const token = createInviteToken();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
      await tx.run(
        `INSERT INTO friend_invites (id, owner_id, token_hash, expires_at)
         VALUES (?, ?, ?, ?)`,
        [uuidv4(), req.user.id, hashInviteToken(token), expiresAt]
      );
      return { status: 201, body: { token, expires_at: expiresAt } };
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[social/friend-invites] create failed:', err.message);
    res.status(500).json({ error: 'Could not create an invite.' });
  }
});

router.post('/friend-invites/:token/request', inviteResolveLimiter, async (req, res) => {
  const token = String(req.params.token || '');
  if (!isInviteTokenShape(token)) return inviteUnavailable(res);

  try {
    const result = await withTransaction(async (tx) => {
      const invite = await tx.get(
        `SELECT id, owner_id
         FROM friend_invites
         WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > NOW()
         FOR UPDATE`,
        [hashInviteToken(token)]
      );
      if (!invite) return { unavailable: true };
      if (invite.owner_id === req.user.id) {
        return { status: 400, body: { error: 'You cannot use your own invite.' } };
      }

      const usersExist = await lockUsers(tx, [req.user.id, invite.owner_id]);
      if (!usersExist) return { unavailable: true };
      const request = await createFriendshipRequest(tx, req.user.id, invite.owner_id);
      if (request.unavailable || !request.createdRequest) return request;

      const consumed = await tx.run(
        `UPDATE friend_invites
         SET consumed_at = NOW(), consumed_by_id = ?
         WHERE id = ? AND owner_id = ? AND token_hash = ?
           AND consumed_at IS NULL AND owner_id <> ?`,
        [req.user.id, invite.id, invite.owner_id, hashInviteToken(token), req.user.id]
      );
      if (consumed.changes !== 1) throw new Error('Invite consume lost its one-use guard');

      return request;
    });

    if (result.unavailable) return inviteUnavailable(res);
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[social/friend-invites] resolve failed:', err.message);
    return res.status(500).json({ error: 'Could not use this invite.' });
  }
});

router.get('/friends', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT f.id, f.status, f.requester_id, f.addressee_id, f.created_at, f.responded_at,
              u.id AS friend_id, u.name AS friend_name,
              CASE WHEN f.status = 'accepted' OR u.friend_discoverable = 1 THEN u.friend_handle ELSE NULL END AS friend_handle
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
       WHERE (f.requester_id = ? OR f.addressee_id = ?)
         AND f.status IN ('pending', 'accepted')
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = ? AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = ?)
         )
       ORDER BY f.updated_at DESC, f.created_at DESC`,
      [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]
    );
    const blocked = await dbAll(
      `SELECT b.id, b.blocked_id AS user_id, u.name, b.created_at
       FROM user_blocks b
       JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = ?
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    const [activeInvites, discoveryProfile] = await Promise.all([
      dbGet(
        `SELECT COUNT(*) AS count FROM friend_invites
         WHERE owner_id = ? AND consumed_at IS NULL AND expires_at > NOW()`,
        [req.user.id]
      ),
      dbGet('SELECT friend_handle, friend_discoverable FROM users WHERE id = ?', [req.user.id]),
    ]);

    const friends = [];
    const incoming = [];
    const outgoing = [];
    for (const row of rows) {
      const item = {
        id: row.id,
        user: { id: row.friend_id, name: row.friend_name, handle: row.friend_handle || null },
        created_at: row.created_at,
        responded_at: row.responded_at,
      };
      if (row.status === 'accepted') friends.push(item);
      else if (row.addressee_id === req.user.id) incoming.push(item);
      else outgoing.push(item);
    }

    res.json({
      friends,
      incoming,
      outgoing,
      blocked,
      discovery: {
        handle: discoveryProfile?.friend_handle || '',
        discoverable: Boolean(discoveryProfile?.friend_handle && discoveryProfile?.friend_discoverable),
      },
      limits: {
        friends: MAX_FRIENDS,
        active_invites: MAX_ACTIVE_INVITES,
        active_invite_count: Number(activeInvites?.count || 0),
      },
    });
  } catch (err) {
    console.error('[social/friends] list failed:', err.message);
    res.status(500).json({ error: 'Could not load friends.' });
  }
});

router.patch('/friendships/:id', relationshipLimiter, async (req, res) => {
  const action = String(req.body?.action || '');
  if (!isUuid(req.params.id) || !['accept', 'decline'].includes(action)) {
    return res.status(400).json({ error: 'Invalid friend request action.' });
  }

  try {
    const result = await withTransaction(async (tx) => {
      const preview = await tx.get(
        `SELECT id, requester_id, addressee_id
         FROM friendships
         WHERE id = ? AND addressee_id = ? AND status = 'pending'`,
        [req.params.id, req.user.id]
      );
      if (!preview) return { status: 404, body: { error: 'Friend request not found.' } };

      if (action === 'accept') {
        const usersExist = await lockUsers(tx, [preview.requester_id, req.user.id]);
        if (!usersExist) return { status: 404, body: { error: 'Friend request not found.' } };
      }

      const friendship = await tx.get(
        `SELECT id, requester_id, addressee_id
         FROM friendships
         WHERE id = ? AND addressee_id = ? AND status = 'pending'
         FOR UPDATE`,
        [req.params.id, req.user.id]
      );
      if (!friendship) return { status: 404, body: { error: 'Friend request not found.' } };

      if (action === 'accept') {
        if (await pairIsBlocked(tx, friendship.requester_id, req.user.id)) {
          return { status: 404, body: { error: 'Friend request not found.' } };
        }
        const requesterCount = await acceptedFriendCount(tx, friendship.requester_id);
        const addresseeCount = await acceptedFriendCount(tx, req.user.id);
        if (requesterCount >= MAX_FRIENDS || addresseeCount >= MAX_FRIENDS) {
          return { status: 409, body: { error: 'One of these accounts has reached the friend limit.' } };
        }
      }

      const update = await tx.run(
        `UPDATE friendships
         SET status = ?, responded_at = NOW(), updated_at = NOW()
         WHERE id = ? AND addressee_id = ? AND status = 'pending'`,
        [action === 'accept' ? 'accepted' : 'declined', req.params.id, req.user.id]
      );
      if (update.changes !== 1) throw new Error('Friend request action lost its ownership guard');
      return { status: 200, body: { ok: true, status: action === 'accept' ? 'accepted' : 'declined' } };
    });

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[social/friendships] respond failed:', err.message);
    return res.status(500).json({ error: 'Could not update this friend request.' });
  }
});

router.delete('/friendships/:id', relationshipLimiter, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid friendship.' });
  try {
    const result = await dbRun(
      `UPDATE friendships
       SET status = 'removed', responded_at = NOW(), updated_at = NOW()
       WHERE id = ? AND (requester_id = ? OR addressee_id = ?)
         AND status IN ('pending', 'accepted')`,
      [req.params.id, req.user.id, req.user.id]
    );
    if (result.changes !== 1) return res.status(404).json({ error: 'Friendship not found.' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[social/friendships] remove failed:', err.message);
    return res.status(500).json({ error: 'Could not remove this friendship.' });
  }
});

router.post('/blocks/:userId', relationshipLimiter, async (req, res) => {
  const targetId = String(req.params.userId || '');
  if (!isUuid(targetId) || targetId === req.user.id) {
    return res.status(400).json({ error: 'Invalid block target.' });
  }

  try {
    const result = await withTransaction(async (tx) => {
      const usersExist = await lockUsers(tx, [req.user.id, targetId]);
      if (!usersExist) return { status: 404, body: { error: 'Account unavailable.' } };
      const [userLowId, userHighId] = canonicalPair(req.user.id, targetId);
      const relationship = await tx.get(
        `SELECT id FROM friendships
         WHERE user_low_id = ? AND user_high_id = ?
           AND (requester_id = ? OR addressee_id = ?)
         FOR UPDATE`,
        [userLowId, userHighId, req.user.id, req.user.id]
      );
      if (!relationship) return { status: 404, body: { error: 'Account unavailable.' } };
      await tx.run(
        `INSERT INTO user_blocks (id, blocker_id, blocked_id)
         VALUES (?, ?, ?)
         ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
        [uuidv4(), req.user.id, targetId]
      );
      await tx.run(
        `UPDATE friendships
         SET status = 'removed', responded_at = NOW(), updated_at = NOW()
         WHERE user_low_id = ? AND user_high_id = ?
           AND (requester_id = ? OR addressee_id = ?)
           AND status IN ('pending', 'accepted')`,
        [userLowId, userHighId, req.user.id, req.user.id]
      );
      await revokeBlockedGroupRunAccess(tx, req.user.id, targetId);
      return { status: 200, body: { ok: true } };
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[social/blocks] create failed:', err.message);
    return res.status(500).json({ error: 'Could not block this account.' });
  }
});

router.delete('/blocks/:userId', relationshipLimiter, async (req, res) => {
  const targetId = String(req.params.userId || '');
  if (!isUuid(targetId)) return res.status(400).json({ error: 'Invalid block target.' });
  try {
    const result = await dbRun(
      'DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?',
      [req.user.id, targetId]
    );
    if (result.changes !== 1) return res.status(404).json({ error: 'Blocked account not found.' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[social/blocks] remove failed:', err.message);
    return res.status(500).json({ error: 'Could not unblock this account.' });
  }
});

router.post('/reports', reportLimiter, async (req, res) => {
  const subjectUserId = String(req.body?.subject_user_id || '');
  const category = String(req.body?.category || '');
  const contextType = String(req.body?.context_type || 'profile');
  if (!isUuid(subjectUserId) || subjectUserId === req.user.id) {
    return res.status(400).json({ error: 'Invalid report subject.' });
  }
  if (!REPORT_CATEGORIES.has(category) || !REPORT_CONTEXTS.has(contextType)) {
    return res.status(400).json({ error: 'Invalid report details.' });
  }

  try {
    const [userLowId, userHighId] = canonicalPair(req.user.id, subjectUserId);
    const relationship = await dbGet(
      `SELECT id FROM friendships
       WHERE user_low_id = ? AND user_high_id = ?
         AND (requester_id = ? OR addressee_id = ?)
       LIMIT 1`,
      [userLowId, userHighId, req.user.id, req.user.id]
    );
    const blocked = await dbGet(
      'SELECT id FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?',
      [req.user.id, subjectUserId]
    );
    if (!relationship && !blocked) return res.status(404).json({ error: 'Account unavailable.' });

    const requestedContextId = boundedText(req.body?.context_id, 80) || null;
    if (contextType === 'friendship' && requestedContextId !== relationship?.id) {
      return res.status(400).json({ error: 'Invalid report context.' });
    }
    const note = boundedText(cleanText(req.body?.note), 500) || null;
    await dbRun(
      `INSERT INTO social_reports
       (id, reporter_id, subject_user_id, category, context_type, context_id, note, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
      [uuidv4(), req.user.id, subjectUserId, category, contextType,
        contextType === 'friendship' ? relationship.id : null, note]
    );
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[social/reports] create failed:', err.message);
    return res.status(500).json({ error: 'Could not submit this report.' });
  }
});

module.exports = router;
