const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { requirePremium } = require('../middleware/premiumGate');
const { getWeather } = require('../services/weather');
const { recommendShoe, recommendApparel } = require('../lib/shoeRecommendation');

const SHOE_CATEGORIES = ['daily_trainer', 'tempo', 'race', 'trail', 'stability'];
const SHOE_SURFACES = ['road', 'trail', 'both'];
const SHOE_CUSHION = ['max', 'balanced', 'firm'];
const INTENT_TAGS = ['easy', 'recovery', 'long', 'tempo', 'threshold', 'intervals', 'speed', 'race', 'trail'];
const RUN_TYPES = new Set(INTENT_TAGS);

const RECOMMENDED_MILES = {
  vaporfly: 200,
  alphafly: 200,
  'adios pro': 225,
  metaspeed: 225,
  'endorphin pro': 225,
  'hyperion elite': 225,
  'fuelcel sc elite': 225,
  'carbon x': 250,
  cloudboom: 225,
  speedcross: 350,
  speedgoat: 350,
  'gel-trabuco': 350,
  peregrine: 350,
  'terra kiger': 350,
  wildhorse: 375,
  catamount: 350,
  'sense ride': 350,
  hierro: 350,
};

const SHOE_SELECT = `
  SELECT g.*,
    c.model_version AS catalog_model_version,
    c.drop_mm AS catalog_drop_mm,
    c.heel_stack_mm AS catalog_heel_stack_mm,
    c.forefoot_stack_mm AS catalog_forefoot_stack_mm,
    c.stability AS catalog_stability,
    c.plate_type AS catalog_plate_type,
    c.rocker AS catalog_rocker,
    c.terrain AS catalog_terrain,
    c.lug_depth_mm AS catalog_lug_depth_mm,
    c.weight_g AS catalog_weight_g,
    c.spec_basis AS catalog_spec_basis,
    c.source_urls AS catalog_source_urls,
    c.verification_status AS catalog_verification_status,
    c.confidence AS catalog_confidence,
    c.verified_at AS catalog_verified_at
  FROM gear_shoes g
  LEFT JOIN shoe_catalog c ON c.id = g.catalog_id
`;

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[gear/parse-list]', err.message);
    return [];
  }
}

function cleanText(value, maxLength) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength);
}

function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

function booleanOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  return null;
}

function normalizeIntentTags(value) {
  const tags = parseList(value)
    .map((tag) => cleanText(tag, 20).toLowerCase())
    .filter((tag) => INTENT_TAGS.includes(tag));
  return [...new Set(tags)].slice(0, 6);
}

function getRecommendedMiles(brand, model) {
  const name = `${brand} ${model}`.toLowerCase();
  for (const [keyword, miles] of Object.entries(RECOMMENDED_MILES)) {
    if (name.includes(keyword)) return miles;
  }
  return 450;
}

function normalizeCatalogRow(row) {
  if (!row) return row;
  return {
    ...row,
    aliases: parseList(row.aliases),
    intent_tags: parseList(row.intent_tags),
    regions: parseList(row.regions),
    source_urls: parseList(row.source_urls),
    verified_fields: parseList(row.verified_fields),
  };
}

function normalizeShoeRow(row) {
  if (!row) return row;
  return {
    ...row,
    intent_tags: parseList(row.intent_tags),
    catalog_source_urls: parseList(row.catalog_source_urls),
  };
}

async function addMileage(shoes, userId) {
  return Promise.all(shoes.map(async (rawShoe) => {
    const shoe = normalizeShoeRow(rawShoe);
    const row = await dbGet(
      'SELECT COALESCE(SUM(distance_miles),0) AS total FROM runs WHERE user_id=? AND shoe_id=?',
      [userId, shoe.id]
    );
    const totalMiles = Number(Number(row?.total || 0).toFixed(2));
    const recommendedMiles = Number(shoe.recommended_miles || 0);
    const pct = recommendedMiles > 0 ? Math.round((totalMiles / recommendedMiles) * 100) : 0;
    return {
      ...shoe,
      total_miles: totalMiles,
      pct_used: pct,
      miles_remaining: Math.max(0, Number((recommendedMiles - totalMiles).toFixed(2))),
      alert: pct >= 80 && !shoe.is_retired,
    };
  }));
}

router.get('/catalog', auth, async (req, res) => {
  try {
    const query = cleanText(req.query.q, 80).toLowerCase();
    if (query.length < 2) return res.json({ shoes: [] });
    const pattern = `%${escapeLikePattern(query)}%`;
    const rows = await dbAll(
      `SELECT * FROM shoe_catalog
       WHERE status IN ('active', 'legacy')
         AND LOWER(brand || ' ' || model || ' ' || COALESCE(aliases, '')) LIKE ? ESCAPE E'\\\\'
       ORDER BY CASE WHEN LOWER(model) = ? THEN 0 ELSE 1 END, brand ASC, model ASC
       LIMIT 20`,
      [pattern, query]
    );
    return res.json({ shoes: rows.map(normalizeCatalogRow) });
  } catch (err) {
    console.error('[gear/catalog]', err.message);
    return res.status(500).json({ error: 'Failed to search the shoe catalog' });
  }
});

router.get('/shoes', auth, async (req, res) => {
  try {
    const includeRetired = req.query.retired === 'true';
    const rows = includeRetired
      ? await dbAll(`${SHOE_SELECT} WHERE g.user_id=? ORDER BY g.is_retired ASC, g.created_at DESC`, [req.user.id])
      : await dbAll(`${SHOE_SELECT} WHERE g.user_id=? AND g.is_retired=0 ORDER BY g.created_at DESC`, [req.user.id]);
    return res.json({ shoes: await addMileage(rows, req.user.id) });
  } catch (err) {
    console.error('[gear/shoes-list]', err.message);
    return res.status(500).json({ error: 'Failed to fetch shoes' });
  }
});

router.get('/recommendation', auth, requirePremium('Smart shoe recommendations'), async (req, res) => {
  try {
    const requestedType = cleanText(req.query.run_type, 20).toLowerCase();
    const runType = RUN_TYPES.has(requestedType) ? requestedType : 'easy';
    const requestedSurface = cleanText(req.query.surface, 20).toLowerCase();
    const surface = SHOE_SURFACES.includes(requestedSurface) ? requestedSurface : 'road';
    const hasLat = req.query.lat !== undefined && req.query.lat !== '';
    const hasLon = req.query.lon !== undefined && req.query.lon !== '';
    const lat = hasLat ? Number(req.query.lat) : null;
    const lon = hasLon ? Number(req.query.lon) : null;

    if ((hasLat && !Number.isFinite(lat)) || (hasLon && !Number.isFinite(lon))) {
      return res.status(400).json({ error: 'lat and lon must be finite numbers' });
    }

    const rows = await dbAll(
      `${SHOE_SELECT} WHERE g.user_id=? AND g.is_retired=0 AND COALESCE(g.is_active,1)=1 ORDER BY g.created_at DESC`,
      [req.user.id]
    );
    const shoes = await addMileage(rows, req.user.id);
    const weather = hasLat && hasLon
      ? await getWeather(lat, lon)
      : {
          tempF: null,
          feelsLikeF: null,
          conditions: null,
          windMph: null,
          isPrecip: false,
          available: false,
          reason: 'Location was not provided',
        };

    return res.json({
      weather,
      shoe: recommendShoe(shoes, runType, weather, surface),
      apparel: recommendApparel(weather),
      run_type: runType,
      surface,
    });
  } catch (err) {
    console.error('[gear/recommendation]', err.message);
    return res.status(500).json({ error: 'Failed to build gear recommendation' });
  }
});

router.post('/shoes', auth, async (req, res) => {
  try {
    const catalogId = cleanText(req.body.catalog_id, 100) || null;
    const catalog = catalogId
      ? await dbGet("SELECT * FROM shoe_catalog WHERE id=? AND status IN ('active', 'legacy')", [catalogId])
      : null;
    if (catalogId && !catalog) return res.status(400).json({ error: 'Catalog shoe was not found' });

    const brand = catalog ? catalog.brand : cleanText(req.body.brand, 60);
    const model = catalog ? catalog.model : cleanText(req.body.model, 100);
    if (!brand || !model) return res.status(400).json({ error: 'brand and model required' });

    const category = catalog?.category || cleanText(req.body.category, 30) || 'daily_trainer';
    const surface = catalog?.surface || cleanText(req.body.surface, 20) || 'road';
    const cushion = catalog?.cushioning || cleanText(req.body.cushion, 20) || null;
    const intentTags = catalog ? parseList(catalog.intent_tags) : normalizeIntentTags(req.body.intent_tags);
    const wetOk = catalog ? booleanOrNull(catalog.wet_ok) : booleanOrNull(req.body.wet_ok);
    if (!SHOE_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid shoe category' });
    if (!SHOE_SURFACES.includes(surface)) return res.status(400).json({ error: 'Invalid shoe surface' });
    if (cushion && !SHOE_CUSHION.includes(cushion)) return res.status(400).json({ error: 'Invalid cushioning' });

    const recommendedMiles = catalog
      ? Number(catalog.recommended_miles_max)
      : getRecommendedMiles(brand, model);
    const id = uuidv4();
    await dbRun(
      `INSERT INTO gear_shoes (
        id, user_id, brand, model, nickname, color, purchase_date, category,
        surface, intent_tags, wet_ok, cushion, catalog_id, recommended_miles
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        req.user.id,
        brand,
        model,
        cleanText(req.body.nickname, 60) || null,
        cleanText(req.body.color, 60) || null,
        cleanText(req.body.purchase_date, 10) || null,
        category,
        surface,
        JSON.stringify(intentTags),
        wetOk,
        cushion,
        catalogId,
        recommendedMiles,
      ]
    );
    const rows = await dbAll(`${SHOE_SELECT} WHERE g.id=? AND g.user_id=?`, [id, req.user.id]);
    const [shoe] = await addMileage(rows, req.user.id);
    return res.status(201).json(shoe);
  } catch (err) {
    console.error('[gear/shoes-add]', err.message);
    return res.status(500).json({ error: 'Failed to add shoe' });
  }
});

router.patch('/shoes/:id', auth, async (req, res) => {
  try {
    const shoe = await dbGet('SELECT * FROM gear_shoes WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!shoe) return res.status(404).json({ error: 'Not found' });

    const allowed = new Set([
      'nickname',
      'color',
      'purchase_date',
      'recommended_miles',
      'is_retired',
      'category',
      'surface',
      'intent_tags',
      'wet_ok',
      'cushion',
    ]);
    const updates = [];
    for (const [key, rawValue] of Object.entries(req.body || {})) {
      if (!allowed.has(key)) continue;
      let value = rawValue;
      if (key === 'category') {
        value = cleanText(rawValue, 30);
        if (!SHOE_CATEGORIES.includes(value)) return res.status(400).json({ error: 'Invalid shoe category' });
      } else if (key === 'surface') {
        value = cleanText(rawValue, 20);
        if (!SHOE_SURFACES.includes(value)) return res.status(400).json({ error: 'Invalid shoe surface' });
      } else if (key === 'cushion') {
        value = cleanText(rawValue, 20) || null;
        if (value && !SHOE_CUSHION.includes(value)) return res.status(400).json({ error: 'Invalid cushioning' });
      } else if (key === 'intent_tags') {
        value = JSON.stringify(normalizeIntentTags(rawValue));
      } else if (key === 'wet_ok') {
        value = booleanOrNull(rawValue);
      } else if (key === 'recommended_miles') {
        value = Number(rawValue);
        if (!Number.isInteger(value) || value < 100 || value > 800) {
          return res.status(400).json({ error: 'Recommended miles must be between 100 and 800' });
        }
      } else if (key === 'is_retired') {
        value = booleanOrNull(rawValue) === 1 ? 1 : 0;
      } else {
        value = cleanText(rawValue, key === 'purchase_date' ? 10 : 60) || null;
      }
      updates.push([key, value]);
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    await dbRun(
      `UPDATE gear_shoes SET ${updates.map(([key]) => `${key}=?`).join(', ')} WHERE id=? AND user_id=?`,
      [...updates.map(([, value]) => value), req.params.id, req.user.id]
    );
    const rows = await dbAll(`${SHOE_SELECT} WHERE g.id=? AND g.user_id=?`, [req.params.id, req.user.id]);
    const [updated] = await addMileage(rows, req.user.id);
    return res.json(updated);
  } catch (err) {
    console.error('[gear/shoes-update]', err.message);
    return res.status(500).json({ error: 'Update failed' });
  }
});

router.post('/shoes/:id/retire', auth, async (req, res) => {
  try {
    const result = await dbRun(
      'UPDATE gear_shoes SET is_retired=1 WHERE id=? AND user_id=?',
      [req.params.id, req.user.id]
    );
    if (!result.changes) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[gear/shoes-retire]', err.message);
    return res.status(500).json({ error: 'Retire failed' });
  }
});

router.delete('/shoes/:id', auth, async (req, res) => {
  try {
    const shoe = await dbGet('SELECT id FROM gear_shoes WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!shoe) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM gear_shoes WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[gear/shoes-delete]', err.message);
    return res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
