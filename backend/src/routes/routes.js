const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db = require('../db')
const auth = require('../middleware/auth')

// GET /api/routes — browse shared routes (paginated, sorted by newest or most liked)
router.get('/', auth, (req, res) => {
  const sort = req.query.sort === 'popular' ? 'likes_count DESC, created_at DESC' : 'created_at DESC'
  const surface = req.query.surface ? String(req.query.surface) : null
  const page = Math.max(1, Number(req.query.page || 1))
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)))
  const offset = (page - 1) * limit

  const rows = surface
    ? db.prepare(`SELECT r.*, u.name as runner_name FROM shared_routes r LEFT JOIN users u ON r.user_id=u.id WHERE r.surface=? ORDER BY ${sort} LIMIT ? OFFSET ?`).all(surface, limit, offset)
    : db.prepare(`SELECT r.*, u.name as runner_name FROM shared_routes r LEFT JOIN users u ON r.user_id=u.id ORDER BY ${sort} LIMIT ? OFFSET ?`).all(limit, offset)

  const likedIds = new Set(
    db.prepare('SELECT route_id FROM route_likes WHERE user_id=?').all(req.user.id).map(l => l.route_id)
  )

  res.json({
    routes: rows.map(r => ({
      ...r,
      route_coords: JSON.parse(r.route_coords || '[]'),
      liked: likedIds.has(r.id),
    })),
    page,
    limit,
  })
})

// GET /api/routes/:id — get single route
router.get('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT r.*, u.name as runner_name FROM shared_routes r LEFT JOIN users u ON r.user_id=u.id WHERE r.id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Route not found' })
  res.json({ ...row, route_coords: JSON.parse(row.route_coords || '[]') })
})

// POST /api/routes — share a route
router.post('/', auth, (req, res) => {
  const { run_id, title, description, route_coords, distance_miles, duration_seconds, avg_pace, surface, city } = req.body
  if (!title) return res.status(400).json({ error: 'title is required' })
  if (!route_coords || !Array.isArray(route_coords) || route_coords.length < 2) {
    return res.status(400).json({ error: 'route_coords must have at least 2 points' })
  }
  const id = uuidv4()
  db.prepare(`INSERT INTO shared_routes (id, user_id, run_id, title, description, route_coords, distance_miles, duration_seconds, avg_pace, surface, city)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, req.user.id, run_id || null, title, description || null,
    JSON.stringify(route_coords), distance_miles || 0, duration_seconds || 0,
    avg_pace || null, surface || null, city || null
  )
  const route = db.prepare('SELECT * FROM shared_routes WHERE id=?').get(id)
  res.status(201).json({ ...route, route_coords })
})

// POST /api/routes/:id/like — toggle like
router.post('/:id/like', auth, (req, res) => {
  const route = db.prepare('SELECT * FROM shared_routes WHERE id=?').get(req.params.id)
  if (!route) return res.status(404).json({ error: 'Not found' })

  const existing = db.prepare('SELECT * FROM route_likes WHERE user_id=? AND route_id=?').get(req.user.id, req.params.id)
  if (existing) {
    db.prepare('DELETE FROM route_likes WHERE user_id=? AND route_id=?').run(req.user.id, req.params.id)
    db.prepare('UPDATE shared_routes SET likes_count = MAX(0, likes_count - 1) WHERE id=?').run(req.params.id)
    res.json({ liked: false, likes_count: Math.max(0, route.likes_count - 1) })
  } else {
    db.prepare('INSERT OR IGNORE INTO route_likes (id, user_id, route_id) VALUES (?,?,?)').run(uuidv4(), req.user.id, req.params.id)
    db.prepare('UPDATE shared_routes SET likes_count = likes_count + 1 WHERE id=?').run(req.params.id)
    res.json({ liked: true, likes_count: route.likes_count + 1 })
  }
})

// DELETE /api/routes/:id — delete own route
router.delete('/:id', auth, (req, res) => {
  const route = db.prepare('SELECT * FROM shared_routes WHERE id=? AND user_id=?').get(req.params.id, req.user.id)
  if (!route) return res.status(404).json({ error: 'Not found' })
  db.prepare('DELETE FROM route_likes WHERE route_id=?').run(req.params.id)
  db.prepare('DELETE FROM shared_routes WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

module.exports = router
