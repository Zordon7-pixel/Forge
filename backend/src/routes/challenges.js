const router = require('express').Router();
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { cleanText } = require('../lib/profanity');

router.get('/', auth, async (req, res) => {
  try {
    const [all, joined] = await Promise.all([
      dbAll('SELECT * FROM challenges ORDER BY sort_order'),
      dbAll('SELECT challenge_id, progress, completed_at FROM user_challenges WHERE user_id = ?', [req.user.id])
    ]);
    const joinedMap = {};
    joined.forEach(j => { joinedMap[j.challenge_id] = j; });
    res.json({
      challenges: all.map(c => ({
        ...c,
        joined: !!joinedMap[c.id],
        progress: joinedMap[c.id]?.progress || 0,
        completed_at: joinedMap[c.id]?.completed_at || null,
      })),
    });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch challenges' }); }
});

router.get('/my', auth, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT c.*, uc.progress, uc.joined_at, uc.completed_at
      FROM user_challenges uc
      JOIN challenges c ON c.id = uc.challenge_id
      WHERE uc.user_id = ?
      ORDER BY uc.joined_at DESC
    `, [req.user.id]);
    res.json({ challenges: rows });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch user challenges' }); }
});

router.post('/:id/join', auth, async (req, res) => {
  try {
    const challenge = await dbGet('SELECT * FROM challenges WHERE id = ?', [req.params.id]);
    if (!challenge) return res.status(404).json({ error: 'Not found' });

    let progress = 0;
    if (challenge.unit === 'miles') {
      const totalMiles = await dbGet('SELECT COALESCE(SUM(distance_miles),0) as m FROM runs WHERE user_id = ?', [req.user.id]);
      progress = Math.min(totalMiles.m, challenge.target_value);
    } else if (challenge.type === 'step_weekly') {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      const steps = await dbGet('SELECT COALESCE(SUM(steps),0) as s FROM step_logs WHERE user_id = ? AND log_date >= ?', [req.user.id, weekAgo.toISOString().slice(0, 10)]);
      progress = Math.min(steps.s, challenge.target_value);
    } else if (challenge.type === 'step_streak') {
      const goalRow = await dbGet('SELECT step_goal FROM users WHERE id = ?', [req.user.id]);
      const goal = goalRow?.step_goal || 10000;
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 6);
      const count = await dbGet('SELECT COUNT(*) as c FROM step_logs WHERE user_id = ? AND log_date >= ? AND steps >= ?', [req.user.id, weekAgo.toISOString().slice(0, 10), goal]);
      progress = Math.min(count.c || 0, challenge.target_value);
    }

    await dbRun('INSERT INTO user_challenges (id, user_id, challenge_id, progress) VALUES (?,?,?,?) ON CONFLICT (user_id, challenge_id) DO NOTHING',
      [uuidv4(), req.user.id, req.params.id, progress]);
    res.json({ ok: true, progress });
  } catch (err) { res.status(500).json({ error: 'Failed to join challenge' }); }
});

router.post('/sync', auth, async (req, res) => {
  try {
    const joined = await dbAll('SELECT uc.*, c.type, c.unit, c.target_value FROM user_challenges uc JOIN challenges c ON c.id = uc.challenge_id WHERE uc.user_id = ?', [req.user.id]);
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 6);
    const weekAgoStr = weekAgo.toISOString().slice(0, 10);

    const [totalMilesRow, stepGoalRow, weeklyStepsRow] = await Promise.all([
      dbGet('SELECT COALESCE(SUM(distance_miles),0) as m FROM runs WHERE user_id = ?', [req.user.id]),
      dbGet('SELECT step_goal FROM users WHERE id = ?', [req.user.id]),
      dbGet('SELECT COALESCE(SUM(steps),0) as s FROM step_logs WHERE user_id = ? AND log_date >= ?', [req.user.id, weekAgoStr])
    ]);

    const totalMiles = totalMilesRow?.m || 0;
    const stepGoal = stepGoalRow?.step_goal || 10000;
    const weeklySteps = weeklyStepsRow?.s || 0;
    const streakRow = await dbGet('SELECT COUNT(*) as c FROM step_logs WHERE user_id = ? AND log_date >= ? AND steps >= ?', [req.user.id, weekAgoStr, stepGoal]);
    const streakDays = streakRow?.c || 0;

    for (const uc of joined) {
      let progress = uc.progress;
      if (uc.unit === 'miles') progress = Math.min(totalMiles, uc.target_value);
      else if (uc.type === 'step_weekly') progress = Math.min(weeklySteps, uc.target_value);
      else if (uc.type === 'step_streak') progress = Math.min(streakDays, uc.target_value);
      const completed = progress >= uc.target_value ? new Date().toISOString() : null;
      await dbRun('UPDATE user_challenges SET progress = ?, completed_at = ? WHERE user_id = ? AND challenge_id = ?',
        [progress, completed || uc.completed_at, req.user.id, uc.challenge_id]);
    }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Sync failed' }); }
});

router.get('/steps/today', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [log, goalRow] = await Promise.all([
      dbGet('SELECT * FROM step_logs WHERE user_id = ? AND log_date = ?', [req.user.id, today]),
      dbGet('SELECT step_goal FROM users WHERE id = ?', [req.user.id])
    ]);
    const goal = goalRow?.step_goal || 10000;
    res.json({ steps: log?.steps || 0, goal, date: today });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch steps' }); }
});

router.post('/steps', auth, async (req, res) => {
  try {
    const { steps, date } = req.body;
    const logDate = date || new Date().toISOString().slice(0, 10);
    await dbRun(
      'INSERT INTO step_logs (id, user_id, log_date, steps, source) VALUES (?,?,?,?,?) ON CONFLICT (user_id, log_date) DO UPDATE SET steps=EXCLUDED.steps',
      [uuidv4(), req.user.id, logDate, steps, 'manual']
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to log steps' }); }
});

router.get('/steps/week', auth, async (req, res) => {
  try {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const [logs, goalRow] = await Promise.all([
      dbAll('SELECT log_date, steps FROM step_logs WHERE user_id = ? AND log_date >= ?', [req.user.id, days[0]]),
      dbGet('SELECT step_goal FROM users WHERE id = ?', [req.user.id])
    ]);
    const logMap = {};
    logs.forEach(l => { logMap[l.log_date] = l.steps; });
    const goal = goalRow?.step_goal || 10000;
    res.json({
      days: days.map(d => ({ date: d, steps: logMap[d] || 0, goal })),
      weekTotal: logs.reduce((a, l) => a + l.steps, 0),
      goal,
    });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch week steps' }); }
});

// POST /api/challenges/create — create a custom challenge and auto-join it
router.post('/create', auth, async (req, res) => {
  try {
    const { name, description, type, target_value, unit, end_date } = req.body;
    if (!name || !target_value || !unit) return res.status(400).json({ error: 'name, target_value, and unit required' });
    const id = `custom-${uuidv4()}`;
    const cleanedName = cleanText(name);
    const cleanedDescription = cleanText(description || '');
    await dbRun(
      'INSERT INTO challenges (id, name, description, type, target_value, unit, badge_color, is_featured, sort_order) VALUES (?,?,?,?,?,?,?,0,99)',
      [id, cleanedName, cleanedDescription, type || 'custom', Number(target_value), unit, '#EAB308']
    );
    await dbRun('INSERT INTO user_challenges (id, user_id, challenge_id, progress) VALUES (?,?,?,0) ON CONFLICT (user_id, challenge_id) DO NOTHING',
      [uuidv4(), req.user.id, id]);
    res.status(201).json({ ok: true, challenge_id: id });
  } catch (err) { res.status(500).json({ error: 'Failed to create challenge' }); }
});

// GET /api/challenges/feed — community activity feed
router.get('/feed', auth, async (req, res) => {
  try {
    const [runs, lifts] = await Promise.all([
      dbAll(`
        SELECT r.id, r.user_id, r.distance_miles, r.duration_seconds, r.date, r.type, r.surface, r.notes,
               r.created_at, u.name as user_name
        FROM runs r
        JOIN users u ON u.id = r.user_id
        ORDER BY r.created_at DESC LIMIT 50
      `),
      dbAll(`
        SELECT ws.id, ws.user_id, ws.started_at, ws.ended_at, ws.notes,
               u.name as user_name,
               COUNT(sets.id) as set_count
        FROM workout_sessions ws
        JOIN users u ON u.id = ws.user_id
        LEFT JOIN workout_sets sets ON sets.session_id = ws.id
        WHERE ws.ended_at IS NOT NULL
        GROUP BY ws.id, ws.user_id, ws.started_at, ws.ended_at, ws.notes, u.name
        ORDER BY ws.started_at DESC LIMIT 50
      `)
    ]);

    const feed = [
      ...runs.map(r => ({ ...r, _type: 'run', _ts: r.created_at || r.date })),
      ...lifts.map(l => ({ ...l, _type: 'lift', _ts: l.started_at }))
    ].sort((a, b) => new Date(b._ts) - new Date(a._ts)).slice(0, 30);

    const enrichedFeed = await Promise.all(feed.map(async item => {
      const [likes, userLiked, commentCount, media] = await Promise.all([
        dbGet('SELECT COUNT(*) as cnt FROM activity_likes WHERE activity_id=? AND activity_type=?', [item.id, item._type]),
        dbGet('SELECT id FROM activity_likes WHERE activity_id=? AND activity_type=? AND user_id=?', [item.id, item._type, req.user.id]),
        dbGet('SELECT COUNT(*) as cnt FROM activity_comments WHERE activity_id=? AND activity_type=?', [item.id, item._type]),
        dbGet('SELECT id FROM activity_media WHERE activity_id=? AND activity_type=? LIMIT 1', [item.id, item._type])
      ]);
      return {
        ...item,
        notes: cleanText(item.notes || ''),
        user_name: cleanText(item.user_name || ''),
        like_count: likes?.cnt || 0,
        user_liked: !!userLiked,
        comment_count: commentCount?.cnt || 0,
        has_photo: !!media,
      };
    }));

    res.json({ feed: enrichedFeed });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch feed' }); }
});

module.exports = router;
