const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');

// GET /api/routes — browse shared routes (paginated, sorted by newest or most liked)
router.get('/', auth, async (req, res) => {
  try {
    const sort = req.query.sort === 'popular' ? 'likes_count DESC, created_at DESC' : 'created_at DESC';
    const surface = req.query.surface ? String(req.query.surface) : null;
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
    const offset = (page - 1) * limit;

    const rows = surface
      ? await dbAll(`SELECT r.*, u.name as runner_name FROM shared_routes r LEFT JOIN users u ON r.user_id=u.id WHERE r.surface=? ORDER BY ${sort} LIMIT ? OFFSET ?`, [surface, limit, offset])
      : await dbAll(`SELECT r.*, u.name as runner_name FROM shared_routes r LEFT JOIN users u ON r.user_id=u.id ORDER BY ${sort} LIMIT ? OFFSET ?`, [limit, offset]);

    const likedRows = await dbAll('SELECT route_id FROM route_likes WHERE user_id=?', [req.user.id]);
    const likedIds = new Set(likedRows.map(l => l.route_id));

    res.json({
      routes: rows.map(r => ({
        ...r,
        route_coords: JSON.parse(r.route_coords || '[]'),
        liked: likedIds.has(r.id),
      })),
      page,
      limit,
    });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch routes' }); }
});

// GET /api/routes/:id — get single route
router.get('/:id', auth, async (req, res) => {
  try {
    const row = await dbGet('SELECT r.*, u.name as runner_name FROM shared_routes r LEFT JOIN users u ON r.user_id=u.id WHERE r.id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Route not found' });
    res.json({ ...row, route_coords: JSON.parse(row.route_coords || '[]') });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch route' }); }
});

// POST /api/routes — share a route
router.post('/', auth, async (req, res) => {
  try {
    const { run_id, title, description, route_coords, distance_miles, duration_seconds, avg_pace, surface, city } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!route_coords || !Array.isArray(route_coords) || route_coords.length < 2) {
      return res.status(400).json({ error: 'route_coords must have at least 2 points' });
    }
    const id = uuidv4();
    await dbRun(
      `INSERT INTO shared_routes (id, user_id, run_id, title, description, route_coords, distance_miles, duration_seconds, avg_pace, surface, city) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.user.id, run_id || null, title, description || null, JSON.stringify(route_coords), distance_miles || 0, duration_seconds || 0, avg_pace || null, surface || null, city || null]
    );
    const route = await dbGet('SELECT * FROM shared_routes WHERE id=?', [id]);
    res.status(201).json({ ...route, route_coords });
  } catch (err) { res.status(500).json({ error: 'Failed to share route' }); }
});

// POST /api/routes/:id/like — toggle like
router.post('/:id/like', auth, async (req, res) => {
  try {
    const route = await dbGet('SELECT * FROM shared_routes WHERE id=?', [req.params.id]);
    if (!route) return res.status(404).json({ error: 'Not found' });

    const existing = await dbGet('SELECT * FROM route_likes WHERE user_id=? AND route_id=?', [req.user.id, req.params.id]);
    if (existing) {
      await dbRun('DELETE FROM route_likes WHERE user_id=? AND route_id=?', [req.user.id, req.params.id]);
      await dbRun('UPDATE shared_routes SET likes_count = GREATEST(0, likes_count - 1) WHERE id=?', [req.params.id]);
      res.json({ liked: false, likes_count: Math.max(0, route.likes_count - 1) });
    } else {
      await dbRun('INSERT INTO route_likes (id, user_id, route_id) VALUES (?,?,?) ON CONFLICT (user_id, route_id) DO NOTHING', [uuidv4(), req.user.id, req.params.id]);
      await dbRun('UPDATE shared_routes SET likes_count = likes_count + 1 WHERE id=?', [req.params.id]);
      res.json({ liked: true, likes_count: route.likes_count + 1 });
    }
  } catch (err) { res.status(500).json({ error: 'Like failed' }); }
});

// DELETE /api/routes/:id — delete own route
router.delete('/:id', auth, async (req, res) => {
  try {
    const route = await dbGet('SELECT * FROM shared_routes WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!route) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM route_likes WHERE route_id=?', [req.params.id]);
    await dbRun('DELETE FROM shared_routes WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

module.exports = router;
