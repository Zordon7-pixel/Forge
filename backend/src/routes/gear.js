const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const auth = require('../middleware/auth');

// Recommended mileage lookup by model keyword
const RECOMMENDED_MILES = {
  // Super shoes / carbon plate (~200 miles)
  vaporfly: 200,
  alphafly: 200,
  'adios pro': 225,
  metaspeed: 225,
  'endorphin pro': 225,
  'hyperion elite': 225,
  'fuelcel sc elite': 225,
  'carbon x': 250,
  cloudboom: 225,
  // Trail shoes (~350 miles)
  speedcross: 350,
  speedgoat: 350,
  'gel-trabuco': 350,
  peregrine: 350,
  'terra kiger': 350,
  wildhorse: 375,
  catamount: 350,
  'sense ride': 350,
  hierro: 350,
  cloudvista: 350,
  cloudultra: 350,
  // Default trainers (~450 miles)
};

function getRecommendedMiles(brand, model) {
  const s = (brand + ' ' + model).toLowerCase();
  for (const [key, miles] of Object.entries(RECOMMENDED_MILES)) {
    if (s.includes(key)) return miles;
  }
  return 450; // default for all standard trainers
}

// GET /api/gear/shoes — list user's shoes with computed mileage
router.get('/shoes', auth, (req, res) => {
  const includeRetired = req.query.retired === 'true';
  const shoes = includeRetired
    ? db.prepare('SELECT * FROM gear_shoes WHERE user_id=? ORDER BY is_retired ASC, created_at DESC').all(req.user.id)
    : db.prepare('SELECT * FROM gear_shoes WHERE user_id=? AND is_retired=0 ORDER BY created_at DESC').all(req.user.id);

  const result = shoes.map((shoe) => {
    const milesRow = db
      .prepare('SELECT COALESCE(SUM(distance_miles), 0) as total FROM runs WHERE user_id=? AND shoe_id=?')
      .get(req.user.id, shoe.id);
    const totalMiles = Number(((milesRow?.total || 0)).toFixed(2));
    const pct = Math.round((totalMiles / shoe.recommended_miles) * 100);
    return {
      ...shoe,
      total_miles: totalMiles,
      pct_used: pct,
      miles_remaining: Math.max(0, shoe.recommended_miles - totalMiles),
      alert: pct >= 80 && !shoe.is_retired,
    };
  });

  res.json({ shoes: result });
});

// GET /api/gear/shoes/:id — single shoe with per-run breakdown
router.get('/shoes/:id', auth, (req, res) => {
  const shoe = db.prepare('SELECT * FROM gear_shoes WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!shoe) return res.status(404).json({ error: 'Not found' });
  const runs = db
    .prepare('SELECT id, date, distance_miles, duration_seconds, run_surface FROM runs WHERE shoe_id=? ORDER BY date DESC LIMIT 20')
    .all(req.params.id);
  const totalMiles = runs.reduce((s, r) => s + Number(r.distance_miles || 0), 0);
  res.json({ ...shoe, total_miles: Number(totalMiles.toFixed(2)), runs });
});

// POST /api/gear/shoes — add a new shoe
router.post('/shoes', auth, (req, res) => {
  const { brand, model, nickname, color, purchase_date } = req.body;
  if (!brand || !model) return res.status(400).json({ error: 'brand and model required' });
  const recommended_miles = getRecommendedMiles(brand, model);
  const id = uuidv4();
  db.prepare('INSERT INTO gear_shoes (id, user_id, brand, model, nickname, color, purchase_date, recommended_miles) VALUES (?,?,?,?,?,?,?,?)').run(
    id,
    req.user.id,
    brand,
    model,
    nickname || null,
    color || null,
    purchase_date || null,
    recommended_miles
  );
  const shoe = db.prepare('SELECT * FROM gear_shoes WHERE id=?').get(id);
  res.status(201).json({ ...shoe, total_miles: 0, pct_used: 0, miles_remaining: recommended_miles, alert: false });
});

// PATCH /api/gear/shoes/:id — update (nickname, color, retire, recommended_miles override)
router.patch('/shoes/:id', auth, (req, res) => {
  const shoe = db.prepare('SELECT * FROM gear_shoes WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!shoe) return res.status(404).json({ error: 'Not found' });
  const allowed = ['nickname', 'color', 'purchase_date', 'recommended_miles', 'is_retired', 'is_active'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  const setClause = updates.map(([k]) => `${k}=?`).join(', ');
  db.prepare(`UPDATE gear_shoes SET ${setClause} WHERE id=?`).run(...updates.map(([, v]) => v), req.params.id);
  res.json(db.prepare('SELECT * FROM gear_shoes WHERE id=?').get(req.params.id));
});

// DELETE /api/gear/shoes/:id
router.delete('/shoes/:id', auth, (req, res) => {
  const shoe = db.prepare('SELECT * FROM gear_shoes WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!shoe) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM gear_shoes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/gear/shoes/:id/retire
router.post('/shoes/:id/retire', auth, (req, res) => {
  db.prepare('UPDATE gear_shoes SET is_retired=1 WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// PATCH /api/runs/:id/shoe — link a run to a shoe
router.patch('/runs/:id/shoe', auth, (req, res) => {
  const { shoe_id } = req.body;
  db.prepare('UPDATE runs SET shoe_id=? WHERE id=? AND user_id=?').run(shoe_id || null, req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
