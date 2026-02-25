const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { cleanText } = require('../lib/profanity');

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function buildActivityRows(userIds = [], limit = 30) {
  if (!userIds.length) return [];
  const safeLimit = Math.min(100, Math.max(1, Number(limit || 30)));
  const placeholders = userIds.map(() => '?').join(',');

  const [runs, lifts, badges, feedRows] = await Promise.all([
    dbAll(`
      SELECT r.id, r.user_id, r.distance_miles, r.duration_seconds, r.type, r.date, r.created_at, u.name as user_name
      FROM runs r
      JOIN users u ON u.id = r.user_id
      WHERE r.user_id IN (${placeholders})
      ORDER BY r.created_at DESC
      LIMIT ?
    `, [...userIds, safeLimit]),
    dbAll(`
      SELECT l.id, l.user_id, l.exercise_name, l.category, l.sets, l.reps, l.weight_lbs, l.date, l.created_at, u.name as user_name
      FROM lifts l
      JOIN users u ON u.id = l.user_id
      WHERE l.user_id IN (${placeholders})
      ORDER BY l.created_at DESC
      LIMIT ?
    `, [...userIds, safeLimit]),
    dbAll(`
      SELECT ub.id, ub.user_id, ub.earned_at as created_at, b.name as badge_name, b.slug as badge_slug, u.name as user_name
      FROM user_badges ub
      JOIN badges b ON b.id = ub.badge_id
      JOIN users u ON u.id = ub.user_id
      WHERE ub.user_id IN (${placeholders})
      ORDER BY ub.earned_at DESC
      LIMIT ?
    `, [...userIds, safeLimit]),
    dbAll(`
      SELECT af.id, af.user_id, af.type, af.data, af.created_at, u.name as user_name
      FROM activity_feed af
      JOIN users u ON u.id = af.user_id
      WHERE af.user_id IN (${placeholders})
      ORDER BY af.created_at DESC
      LIMIT ?
    `, [...userIds, safeLimit]),
  ]);

  const rows = [
    ...feedRows.map((r) => ({ id: r.id, user_id: r.user_id, user_name: r.user_name, type: r.type, data: parseJson(r.data, {}), created_at: r.created_at })),
    ...runs.map((r) => ({
      id: `run-${r.id}`,
      source_id: r.id,
      user_id: r.user_id,
      user_name: r.user_name,
      type: 'run',
      data: { distance_miles: Number(r.distance_miles || 0), duration_seconds: Number(r.duration_seconds || 0), run_type: r.type, date: r.date },
      created_at: r.created_at,
    })),
    ...lifts.map((l) => ({
      id: `lift-${l.id}`,
      source_id: l.id,
      user_id: l.user_id,
      user_name: l.user_name,
      type: 'lift',
      data: { exercise_name: l.exercise_name, category: l.category, sets: l.sets, reps: l.reps, weight_lbs: l.weight_lbs, date: l.date },
      created_at: l.created_at,
    })),
    ...badges.map((b) => ({
      id: `badge-${b.id}`,
      source_id: b.id,
      user_id: b.user_id,
      user_name: b.user_name,
      type: 'achievement',
      data: { badge_name: b.badge_name, badge_slug: b.badge_slug },
      created_at: b.created_at,
    })),
  ];

  rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return rows.slice(0, safeLimit);
}

router.get('/feed', auth, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 30)));
    const follows = await dbAll('SELECT following_id FROM follows WHERE follower_id = ?', [req.user.id]);
    const userIds = Array.from(new Set([req.user.id, ...follows.map((f) => f.following_id)]));
    const rows = await buildActivityRows(userIds, limit);

    const followable = await dbAll(`
      SELECT id, name
      FROM users
      WHERE id <> ?
      ORDER BY created_at DESC
      LIMIT 20
    `, [req.user.id]);

    const followingSet = new Set(follows.map((f) => f.following_id));
    const withCounts = await Promise.all(rows.map(async (item) => {
      const likeRow = await dbGet(
        'SELECT COUNT(*) as cnt FROM activity_likes WHERE activity_id = ? AND (activity_type = ? OR activity_type IS NULL)',
        [item.id, 'feed']
      );
      const likedRow = await dbGet(
        'SELECT id FROM activity_likes WHERE activity_id = ? AND (activity_type = ? OR activity_type IS NULL) AND user_id = ?',
        [item.id, 'feed', req.user.id]
      );
      const commentRow = await dbGet(
        'SELECT COUNT(*) as cnt FROM activity_comments WHERE activity_id = ? AND (activity_type = ? OR activity_type IS NULL)',
        [item.id, 'feed']
      );
      return {
        ...item,
        likes_count: Number(likeRow?.cnt || 0),
        comments_count: Number(commentRow?.cnt || 0),
        liked: Boolean(likedRow),
        is_following: followingSet.has(item.user_id),
      };
    }));

    res.json({
      items: withCounts,
      suggested_users: followable.map((u) => ({
        id: u.id,
        name: u.name,
        is_following: followingSet.has(u.id),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
});

router.post('/follow/:userId', auth, async (req, res) => {
  try {
    const userId = req.params.userId;
    if (!userId || userId === req.user.id) return res.status(400).json({ error: 'Invalid follow target' });
    const target = await dbGet('SELECT id FROM users WHERE id = ?', [userId]);
    if (!target) return res.status(404).json({ error: 'User not found' });

    await dbRun(
      `INSERT INTO follows (id, follower_id, following_id)
       VALUES (?,?,?)
       ON CONFLICT (follower_id, following_id) DO NOTHING`,
      [uuidv4(), req.user.id, userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Follow failed' });
  }
});

router.delete('/unfollow/:userId', auth, async (req, res) => {
  try {
    await dbRun('DELETE FROM follows WHERE follower_id = ? AND following_id = ?', [req.user.id, req.params.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Unfollow failed' });
  }
});

router.post('/like/:activityId', auth, async (req, res) => {
  try {
    const activityId = req.params.activityId;
    const existing = await dbGet(
      'SELECT id FROM activity_likes WHERE activity_id = ? AND (activity_type = ? OR activity_type IS NULL) AND user_id = ?',
      [activityId, 'feed', req.user.id]
    );

    if (existing) {
      await dbRun('DELETE FROM activity_likes WHERE id = ?', [existing.id]);
    } else {
      await dbRun(
        'INSERT INTO activity_likes (id, activity_id, activity_type, user_id) VALUES (?,?,?,?)',
        [uuidv4(), activityId, 'feed', req.user.id]
      );
    }

    const countRow = await dbGet(
      'SELECT COUNT(*) as cnt FROM activity_likes WHERE activity_id = ? AND (activity_type = ? OR activity_type IS NULL)',
      [activityId, 'feed']
    );
    res.json({ liked: !existing, likes_count: Number(countRow?.cnt || 0) });
  } catch (err) {
    res.status(500).json({ error: 'Like failed' });
  }
});

router.get('/comment/:activityId', auth, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT c.id, c.user_id, u.name as user_name, COALESCE(c.text, c.content) as text, c.created_at
      FROM activity_comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.activity_id = ? AND (c.activity_type = ? OR c.activity_type IS NULL)
      ORDER BY c.created_at ASC
      LIMIT 100
    `, [req.params.activityId, 'feed']);
    res.json({ comments: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

router.post('/comment/:activityId', auth, async (req, res) => {
  try {
    const activityId = req.params.activityId;
    const text = cleanText(String(req.body?.text || req.body?.content || '').trim());
    if (!text) return res.status(400).json({ error: 'Comment text is required' });
    if (text.length > 280) return res.status(400).json({ error: 'Comment must be 280 characters or less' });

    const id = uuidv4();
    await dbRun(
      'INSERT INTO activity_comments (id, activity_id, activity_type, user_id, text, content) VALUES (?,?,?,?,?,?)',
      [id, activityId, 'feed', req.user.id, text, text]
    );

    const comment = await dbGet(`
      SELECT c.id, c.user_id, u.name as user_name, COALESCE(c.text, c.content) as text, c.created_at
      FROM activity_comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.id = ?
    `, [id]);
    res.status(201).json({ comment });
  } catch (err) {
    res.status(500).json({ error: 'Comment failed' });
  }
});

router.post('/:activity_type/:activity_id/photo', auth, async (req, res) => {
  try {
    const { activity_id, activity_type } = req.params;
    const data = String(req.body?.data || '');
    const mimeType = String(req.body?.mime_type || 'image/jpeg');
    if (!data) return res.status(400).json({ error: 'Photo data is required' });
    if (data.length > 1000000) return res.status(400).json({ error: 'Photo too large — must be under 1MB' });
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return res.status(400).json({ error: 'Invalid image type' });

    const existing = await dbGet(
      'SELECT id FROM activity_media WHERE activity_id = ? AND activity_type = ? LIMIT 1',
      [activity_id, activity_type]
    );

    let mediaId = existing?.id;
    if (existing) {
      await dbRun('UPDATE activity_media SET data = ?, mime_type = ?, user_id = ? WHERE id = ?',
        [data, mimeType, req.user.id, existing.id]);
    } else {
      mediaId = uuidv4();
      await dbRun(
        'INSERT INTO activity_media (id, activity_id, activity_type, user_id, data, mime_type) VALUES (?,?,?,?,?,?)',
        [mediaId, activity_id, activity_type, req.user.id, data, mimeType]
      );
    }

    const media = await dbGet('SELECT id, data, mime_type FROM activity_media WHERE id = ?', [mediaId]);
    res.json({ media });
  } catch {
    res.status(500).json({ error: 'Failed to save photo' });
  }
});

router.get('/:activity_type/:activity_id/photo', auth, async (req, res) => {
  try {
    const { activity_id, activity_type } = req.params;
    const media = await dbGet(
      'SELECT id, data, mime_type FROM activity_media WHERE activity_id = ? AND activity_type = ? LIMIT 1',
      [activity_id, activity_type]
    );
    res.json({ media: media || null });
  } catch {
    res.status(500).json({ error: 'Failed to fetch photo' });
  }
});

// Legacy compatibility
router.post('/like', auth, async (req, res) => {
  try {
    const activityId = req.body?.activity_id;
    const activityType = String(req.body?.activity_type || 'feed');
    if (!activityId) return res.status(400).json({ error: 'activity_id is required' });

    const existing = await dbGet(
      'SELECT id FROM activity_likes WHERE activity_id = ? AND (activity_type = ? OR activity_type IS NULL) AND user_id = ?',
      [activityId, activityType, req.user.id]
    );
    if (existing) {
      await dbRun('DELETE FROM activity_likes WHERE id = ?', [existing.id]);
    } else {
      await dbRun('INSERT INTO activity_likes (id, activity_id, activity_type, user_id) VALUES (?,?,?,?)',
        [uuidv4(), activityId, activityType, req.user.id]);
    }
    const countRow = await dbGet(
      'SELECT COUNT(*) as cnt FROM activity_likes WHERE activity_id = ? AND (activity_type = ? OR activity_type IS NULL)',
      [activityId, activityType]
    );
    res.json({ liked: !existing, count: Number(countRow?.cnt || 0) });
  } catch {
    res.status(500).json({ error: 'Like failed' });
  }
});

router.get('/:activity_type/:activity_id/comments', auth, async (req, res) => {
  try {
    const activityId = req.params.activity_id;
    const activityType = String(req.params.activity_type || 'feed');
    const rows = await dbAll(`
      SELECT c.id, c.user_id, u.name as user_name, COALESCE(c.text, c.content) as content, c.created_at
      FROM activity_comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.activity_id = ? AND (c.activity_type = ? OR c.activity_type IS NULL)
      ORDER BY c.created_at ASC
      LIMIT 100
    `, [activityId, activityType]);
    res.json({ comments: rows });
  } catch {
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

router.post('/:activity_type/:activity_id/comments', auth, async (req, res) => {
  try {
    const activityId = req.params.activity_id;
    const activityType = String(req.params.activity_type || 'feed');
    const text = cleanText(String(req.body?.content || req.body?.text || '').trim());
    if (!text) return res.status(400).json({ error: 'Comment is required' });
    if (text.length > 280) return res.status(400).json({ error: 'Comment must be 280 characters or less' });

    const id = uuidv4();
    await dbRun(
      'INSERT INTO activity_comments (id, activity_id, activity_type, user_id, text, content) VALUES (?,?,?,?,?,?)',
      [id, activityId, activityType, req.user.id, text, text]
    );
    const row = await dbGet(`
      SELECT c.id, c.user_id, u.name as user_name, COALESCE(c.text, c.content) as content, c.created_at
      FROM activity_comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.id = ?
    `, [id]);
    res.status(201).json({ comment: row });
  } catch {
    res.status(500).json({ error: 'Comment failed' });
  }
});

module.exports = router;
