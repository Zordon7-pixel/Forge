const router = require('express').Router()
const db = require('../db')
const auth = require('../middleware/auth')
const { v4: uuidv4 } = require('uuid')

router.get('/', auth, (req, res) => {
  const all = db.prepare('SELECT * FROM challenges ORDER BY sort_order').all()
  const joined = db.prepare('SELECT challenge_id, progress, completed_at FROM user_challenges WHERE user_id = ?').all(req.user.id)
  const joinedMap = {}
  joined.forEach(j => { joinedMap[j.challenge_id] = j })
  res.json({
    challenges: all.map(c => ({
      ...c,
      joined: !!joinedMap[c.id],
      progress: joinedMap[c.id]?.progress || 0,
      completed_at: joinedMap[c.id]?.completed_at || null,
    })),
  })
})

router.get('/my', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, uc.progress, uc.joined_at, uc.completed_at
    FROM user_challenges uc
    JOIN challenges c ON c.id = uc.challenge_id
    WHERE uc.user_id = ?
    ORDER BY uc.joined_at DESC
  `).all(req.user.id)
  res.json({ challenges: rows })
})

router.post('/:id/join', auth, (req, res) => {
  const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(req.params.id)
  if (!challenge) return res.status(404).json({ error: 'Not found' })

  let progress = 0
  if (challenge.unit === 'miles') {
    const totalMiles = db.prepare('SELECT COALESCE(SUM(distance_miles),0) as m FROM runs WHERE user_id = ?').get(req.user.id)
    progress = Math.min(totalMiles.m, challenge.target_value)
  } else if (challenge.type === 'step_weekly') {
    const weekAgo = new Date()
    weekAgo.setDate(weekAgo.getDate() - 7)
    const steps = db.prepare('SELECT COALESCE(SUM(steps),0) as s FROM step_logs WHERE user_id = ? AND log_date >= ?').get(req.user.id, weekAgo.toISOString().slice(0, 10))
    progress = Math.min(steps.s, challenge.target_value)
  } else if (challenge.type === 'step_streak') {
    const goal = db.prepare('SELECT step_goal FROM users WHERE id = ?').get(req.user.id)?.step_goal || 10000
    const weekAgo = new Date()
    weekAgo.setDate(weekAgo.getDate() - 6)
    const count = db.prepare('SELECT COUNT(*) as c FROM step_logs WHERE user_id = ? AND log_date >= ? AND steps >= ?').get(req.user.id, weekAgo.toISOString().slice(0, 10), goal)
    progress = Math.min(count.c || 0, challenge.target_value)
  }

  db.prepare('INSERT OR IGNORE INTO user_challenges (id, user_id, challenge_id, progress) VALUES (?,?,?,?)').run(uuidv4(), req.user.id, req.params.id, progress)
  res.json({ ok: true, progress })
})

router.post('/sync', auth, (req, res) => {
  const joined = db.prepare('SELECT uc.*, c.type, c.unit, c.target_value FROM user_challenges uc JOIN challenges c ON c.id = uc.challenge_id WHERE uc.user_id = ?').all(req.user.id)
  const totalMiles = db.prepare('SELECT COALESCE(SUM(distance_miles),0) as m FROM runs WHERE user_id = ?').get(req.user.id)?.m || 0
  const stepGoal = db.prepare('SELECT step_goal FROM users WHERE id = ?').get(req.user.id)?.step_goal || 10000
  const weekAgo = new Date()
  weekAgo.setDate(weekAgo.getDate() - 6)
  const weeklySteps = db.prepare('SELECT COALESCE(SUM(steps),0) as s FROM step_logs WHERE user_id = ? AND log_date >= ?').get(req.user.id, weekAgo.toISOString().slice(0, 10))?.s || 0
  const streakDays = db.prepare('SELECT COUNT(*) as c FROM step_logs WHERE user_id = ? AND log_date >= ? AND steps >= ?').get(req.user.id, weekAgo.toISOString().slice(0, 10), stepGoal)?.c || 0

  for (const uc of joined) {
    let progress = uc.progress
    if (uc.unit === 'miles') progress = Math.min(totalMiles, uc.target_value)
    else if (uc.type === 'step_weekly') progress = Math.min(weeklySteps, uc.target_value)
    else if (uc.type === 'step_streak') progress = Math.min(streakDays, uc.target_value)
    const completed = progress >= uc.target_value ? new Date().toISOString() : null
    db.prepare('UPDATE user_challenges SET progress = ?, completed_at = ? WHERE user_id = ? AND challenge_id = ?').run(progress, completed || uc.completed_at, req.user.id, uc.challenge_id)
  }

  res.json({ ok: true })
})

router.get('/steps/today', auth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const log = db.prepare('SELECT * FROM step_logs WHERE user_id = ? AND log_date = ?').get(req.user.id, today)
  const goal = db.prepare('SELECT step_goal FROM users WHERE id = ?').get(req.user.id)?.step_goal || 10000
  res.json({ steps: log?.steps || 0, goal, date: today })
})

router.post('/steps', auth, (req, res) => {
  const { steps, date } = req.body
  const logDate = date || new Date().toISOString().slice(0, 10)
  db.prepare('INSERT INTO step_logs (id, user_id, log_date, steps, source) VALUES (?,?,?,?,?) ON CONFLICT(user_id, log_date) DO UPDATE SET steps=excluded.steps').run(uuidv4(), req.user.id, logDate, steps, 'manual')
  res.json({ ok: true })
})

router.get('/steps/week', auth, (req, res) => {
  const days = []
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    days.push(d.toISOString().slice(0, 10))
  }

  const logs = db.prepare('SELECT log_date, steps FROM step_logs WHERE user_id = ? AND log_date >= ?').all(req.user.id, days[0])
  const logMap = {}
  logs.forEach(l => { logMap[l.log_date] = l.steps })
  const goal = db.prepare('SELECT step_goal FROM users WHERE id = ?').get(req.user.id)?.step_goal || 10000

  res.json({
    days: days.map(d => ({ date: d, steps: logMap[d] || 0, goal })),
    weekTotal: logs.reduce((a, l) => a + l.steps, 0),
    goal,
  })
})

// POST /api/challenges/create — create a custom challenge and auto-join it
router.post('/create', auth, (req, res) => {
  const { name, description, type, target_value, unit, end_date } = req.body
  if (!name || !target_value || !unit) return res.status(400).json({ error: 'name, target_value, and unit required' })
  const id = `custom-${uuidv4()}`
  db.prepare('INSERT INTO challenges (id, name, description, type, target_value, unit, badge_color, is_featured, sort_order) VALUES (?,?,?,?,?,?,?,0,99)')
    .run(id, name, description || '', type || 'custom', Number(target_value), unit, '#EAB308')
  // Auto-join
  db.prepare('INSERT OR IGNORE INTO user_challenges (id, user_id, challenge_id, progress) VALUES (?,?,?,0)')
    .run(uuidv4(), req.user.id, id)
  res.status(201).json({ ok: true, challenge_id: id })
})

// GET /api/challenges/feed — community activity feed (all users' recent runs + lifts)
router.get('/feed', auth, (req, res) => {
  const runs = db.prepare(`
    SELECT r.id, r.user_id, r.distance_miles, r.duration_seconds, r.date, r.type, r.surface, r.notes,
           r.created_at, u.name as user_name
    FROM runs r
    JOIN users u ON u.id = r.user_id
    ORDER BY r.created_at DESC LIMIT 50
  `).all()

  const lifts = db.prepare(`
    SELECT ws.id, ws.user_id, ws.started_at, ws.ended_at, ws.notes,
           u.name as user_name,
           COUNT(sets.id) as set_count
    FROM workout_sessions ws
    JOIN users u ON u.id = ws.user_id
    LEFT JOIN workout_sets sets ON sets.session_id = ws.id
    WHERE ws.ended_at IS NOT NULL
    GROUP BY ws.id
    ORDER BY ws.started_at DESC LIMIT 50
  `).all()

  // Merge and sort by date
  const feed = [
    ...runs.map(r => ({ ...r, _type: 'run', _ts: r.created_at || r.date })),
    ...lifts.map(l => ({ ...l, _type: 'lift', _ts: l.started_at }))
  ].sort((a, b) => new Date(b._ts) - new Date(a._ts)).slice(0, 30)

  const enrichedFeed = feed.map(item => {
    const likes = db.prepare('SELECT COUNT(*) as cnt FROM activity_likes WHERE activity_id=? AND activity_type=?').get(item.id, item._type)
    const userLiked = db.prepare('SELECT id FROM activity_likes WHERE activity_id=? AND activity_type=? AND user_id=?').get(item.id, item._type, req.user.id)
    const commentCount = db.prepare('SELECT COUNT(*) as cnt FROM activity_comments WHERE activity_id=? AND activity_type=?').get(item.id, item._type)
    const media = db.prepare('SELECT id FROM activity_media WHERE activity_id=? AND activity_type=? LIMIT 1').get(item.id, item._type)

    return {
      ...item,
      like_count: likes.cnt,
      user_liked: !!userLiked,
      comment_count: commentCount.cnt,
      has_photo: !!media,
    }
  })

  res.json({ feed: enrichedFeed })
})

module.exports = router
