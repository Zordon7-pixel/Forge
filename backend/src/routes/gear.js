const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');

const RECOMMENDED_MILES = {
  'vaporfly': 200, 'alphafly': 200, 'adios pro': 225, 'metaspeed': 225,
  'endorphin pro': 225, 'hyperion elite': 225, 'fuelcel sc elite': 225,
  'carbon x': 250, 'cloudboom': 225,
  'speedcross': 350, 'speedgoat': 350, 'gel-trabuco': 350, 'peregrine': 350,
  'terra kiger': 350, 'wildhorse': 375, 'catamount': 350, 'sense ride': 350,
  'hierro': 350,
};

function getRecommendedMiles(brand, model) {
  const s = (brand + ' ' + model).toLowerCase();
  for (const [k, v] of Object.entries(RECOMMENDED_MILES)) {
    if (s.includes(k)) return v;
  }
  return 450;
}

router.get('/shoes', auth, async (req, res) => {
  try {
    const includeRetired = req.query.retired === 'true';
    const shoes = includeRetired
      ? await dbAll('SELECT * FROM gear_shoes WHERE user_id=? ORDER BY is_retired ASC, created_at DESC', [req.user.id])
      : await dbAll('SELECT * FROM gear_shoes WHERE user_id=? AND is_retired=0 ORDER BY created_at DESC', [req.user.id]);
    const result = await Promise.all(shoes.map(async (shoe) => {
      const row = await dbGet('SELECT COALESCE(SUM(distance_miles),0) as total FROM runs WHERE user_id=? AND shoe_id=?', [req.user.id, shoe.id]);
      const totalMiles = Number((row?.total || 0).toFixed(2));
      const pct = Math.round((totalMiles / shoe.recommended_miles) * 100);
      return { ...shoe, total_miles: totalMiles, pct_used: pct, miles_remaining: Math.max(0, shoe.recommended_miles - totalMiles), alert: pct >= 80 && !shoe.is_retired };
    }));
    res.json({ shoes: result });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch shoes' }); }
});

router.post('/shoes', auth, async (req, res) => {
  try {
    const { brand, model, nickname, color, purchase_date } = req.body;
    if (!brand || !model) return res.status(400).json({ error: 'brand and model required' });
    const recommended_miles = getRecommendedMiles(brand, model);
    const id = uuidv4();
    await dbRun(
      'INSERT INTO gear_shoes (id, user_id, brand, model, nickname, color, purchase_date, recommended_miles) VALUES (?,?,?,?,?,?,?,?)',
      [id, req.user.id, brand, model, nickname||null, color||null, purchase_date||null, recommended_miles]
    );
    const shoe = await dbGet('SELECT * FROM gear_shoes WHERE id=?', [id]);
    res.status(201).json({ ...shoe, total_miles: 0, pct_used: 0, miles_remaining: recommended_miles, alert: false });
  } catch (err) { res.status(500).json({ error: 'Failed to add shoe' }); }
});

router.patch('/shoes/:id', auth, async (req, res) => {
  try {
    const shoe = await dbGet('SELECT * FROM gear_shoes WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!shoe) return res.status(404).json({ error: 'Not found' });
    const allowed = ['nickname', 'color', 'purchase_date', 'recommended_miles', 'is_retired'];
    const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    await dbRun(
      `UPDATE gear_shoes SET ${updates.map(([k]) => k+'=?').join(', ')} WHERE id=?`,
      [...updates.map(([,v]) => v), req.params.id]
    );
    const updated = await dbGet('SELECT * FROM gear_shoes WHERE id=?', [req.params.id]);
    res.json(updated);
  } catch (err) { res.status(500).json({ error: 'Update failed' }); }
});

router.post('/shoes/:id/retire', auth, async (req, res) => {
  try {
    await dbRun('UPDATE gear_shoes SET is_retired=1 WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Retire failed' }); }
});

router.delete('/shoes/:id', auth, async (req, res) => {
  try {
    const shoe = await dbGet('SELECT * FROM gear_shoes WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!shoe) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM gear_shoes WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

module.exports = router;
