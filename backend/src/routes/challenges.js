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

module.exports = router
