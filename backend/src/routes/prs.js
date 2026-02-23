const router = require('express').Router()
const db = require('../db')
const auth = require('../middleware/auth')
const { v4: uuidv4 } = require('uuid')

// GET /api/prs — get all PRs for user
router.get('/', auth, (req, res) => {
  const prs = db.prepare(`
    SELECT * FROM personal_records
    WHERE user_id = ?
    ORDER BY category, achieved_at DESC
  `).all(req.user.id)
  res.json({ prs })
})

// POST /api/prs — add a PR manually
router.post('/', auth, (req, res) => {
  const { category, label, value, unit, notes, achieved_at } = req.body
  if (!category || !label || value == null || !unit) return res.status(400).json({ error: 'Missing fields' })

  const id = uuidv4()
  db.prepare(`INSERT INTO personal_records (id, user_id, category, label, value, unit, notes, achieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    req.user.id,
    category,
    label,
    Number(value),
    unit,
    notes || null,
    achieved_at || new Date().toISOString().slice(0, 10)
  )

  res.json(db.prepare('SELECT * FROM personal_records WHERE id = ?').get(id))
})

// DELETE /api/prs/:id
router.delete('/:id', auth, (req, res) => {
  const pr = db.prepare('SELECT * FROM personal_records WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id)
  if (!pr) return res.status(404).json({ error: 'Not found' })

  db.prepare('DELETE FROM personal_records WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// POST /api/prs/auto-detect — called after a run is saved, auto-detects new PRs
router.post('/auto-detect', auth, (req, res) => {
  const { run_id } = req.body
  const run = run_id ? db.prepare('SELECT * FROM runs WHERE id = ? AND user_id = ?').get(run_id, req.user.id) : null
  const newPRs = []

  if (run && run.distance_miles && run.duration_seconds) {
    // Check longest run
    const longestRun = db.prepare(`SELECT MAX(distance_miles) as max FROM runs WHERE user_id = ? AND id != ?`).get(req.user.id, run.id)
    if (!longestRun.max || run.distance_miles > longestRun.max) {
      const existing = db.prepare(`SELECT * FROM personal_records WHERE user_id = ? AND category = 'run' AND label = 'Longest Run'`).get(req.user.id)
      if (!existing || run.distance_miles > existing.value) {
        if (existing) db.prepare('DELETE FROM personal_records WHERE id = ?').run(existing.id)
        const id = uuidv4()
        db.prepare(`INSERT INTO personal_records (id, user_id, category, label, value, unit, run_id, achieved_at) VALUES (?, ?, 'run', 'Longest Run', ?, 'mi', ?, ?)`).run(
          id,
          req.user.id,
          run.distance_miles,
          run.id,
          run.date || new Date().toISOString().slice(0, 10)
        )
        newPRs.push({ label: 'Longest Run', value: run.distance_miles, unit: 'mi' })
      }
    }

    // Check fastest pace
    const pace = run.duration_seconds / 60 / run.distance_miles
    const fastestPace = db.prepare(`SELECT MIN(duration_seconds / 60.0 / distance_miles) as min FROM runs WHERE user_id = ? AND distance_miles > 0 AND duration_seconds > 0 AND id != ?`).get(req.user.id, run.id)
    if (!fastestPace.min || pace < fastestPace.min) {
      const existing = db.prepare(`SELECT * FROM personal_records WHERE user_id = ? AND category = 'run' AND label = 'Fastest Pace'`).get(req.user.id)
      if (!existing || pace < existing.value) {
        if (existing) db.prepare('DELETE FROM personal_records WHERE id = ?').run(existing.id)
        const id = uuidv4()
        db.prepare(`INSERT INTO personal_records (id, user_id, category, label, value, unit, run_id, achieved_at) VALUES (?, ?, 'run', 'Fastest Pace', ?, 'min/mi', ?, ?)`).run(
          id,
          req.user.id,
          pace,
          run.id,
          run.date || new Date().toISOString().slice(0, 10)
        )
        newPRs.push({ label: 'Fastest Pace', value: pace, unit: 'min/mi' })
      }
    }
  }

  res.json({ newPRs })
})

module.exports = router
