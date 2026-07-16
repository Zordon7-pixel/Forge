const pg = require('./postgres');
const SHOES = require('../data/shoe_catalog.seed.json');

function json(value) {
  return JSON.stringify(value ?? []);
}

async function seedShoeCatalog() {
  for (const shoe of SHOES) {
    await pg.query(
      `INSERT INTO shoe_catalog (
        id, brand, model, model_version, release_year, aliases, category, surface,
        intent_tags, drop_mm, heel_stack_mm, forefoot_stack_mm, cushioning,
        stability, plate_type, rocker, terrain, lug_depth_mm, weight_g, spec_basis,
        recommended_miles_min, recommended_miles_max, wet_ok, regions, status,
        source_urls, verified_fields, verification_status, confidence, verified_at,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
        $29, $30, $31
      )
      ON CONFLICT (id) DO UPDATE SET
        brand = EXCLUDED.brand,
        model = EXCLUDED.model,
        model_version = EXCLUDED.model_version,
        release_year = EXCLUDED.release_year,
        aliases = EXCLUDED.aliases,
        category = EXCLUDED.category,
        surface = EXCLUDED.surface,
        intent_tags = EXCLUDED.intent_tags,
        drop_mm = EXCLUDED.drop_mm,
        heel_stack_mm = EXCLUDED.heel_stack_mm,
        forefoot_stack_mm = EXCLUDED.forefoot_stack_mm,
        cushioning = EXCLUDED.cushioning,
        stability = EXCLUDED.stability,
        plate_type = EXCLUDED.plate_type,
        rocker = EXCLUDED.rocker,
        terrain = EXCLUDED.terrain,
        lug_depth_mm = EXCLUDED.lug_depth_mm,
        weight_g = EXCLUDED.weight_g,
        spec_basis = EXCLUDED.spec_basis,
        recommended_miles_min = EXCLUDED.recommended_miles_min,
        recommended_miles_max = EXCLUDED.recommended_miles_max,
        wet_ok = EXCLUDED.wet_ok,
        regions = EXCLUDED.regions,
        status = EXCLUDED.status,
        source_urls = EXCLUDED.source_urls,
        verified_fields = EXCLUDED.verified_fields,
        verification_status = EXCLUDED.verification_status,
        confidence = EXCLUDED.confidence,
        verified_at = EXCLUDED.verified_at,
        updated_at = EXCLUDED.updated_at`,
      [
        shoe.id,
        shoe.brand,
        shoe.model,
        shoe.model_version || null,
        shoe.release_year || null,
        json(shoe.aliases),
        shoe.category,
        shoe.surface,
        json(shoe.intent_tags),
        shoe.drop_mm,
        shoe.heel_stack_mm,
        shoe.forefoot_stack_mm,
        shoe.cushioning,
        shoe.stability,
        shoe.plate_type,
        shoe.rocker,
        shoe.terrain,
        shoe.lug_depth_mm,
        shoe.weight_g,
        shoe.spec_basis || null,
        shoe.recommended_miles_min,
        shoe.recommended_miles_max,
        shoe.wet_ok === null || shoe.wet_ok === undefined ? null : (shoe.wet_ok ? 1 : 0),
        json(shoe.regions),
        shoe.status,
        json(shoe.source_urls),
        json(shoe.verified_fields),
        shoe.verification_status,
        shoe.confidence,
        shoe.verified_at,
        shoe.updated_at,
      ]
    );
  }
}

module.exports = { seedShoeCatalog, SHOES };
