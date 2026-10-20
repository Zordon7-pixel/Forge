const router = require('express').Router();
const auth = require('../middleware/auth');
const { requireDiagnosticsAdmin } = require('./diagnostics');
const backendPackage = require('../../package.json');

// Phase 1: runtime-only public tile credential; never add server routing keys.
// Before broad enablement Hermes must verify account-side restrictions/usage;
// public API-key docs do not document self-service domain/app restrictions.
// Hobby: 150,000 tiles/month, no surge charges or promised hard quota cutoff.
// One tile = one request (static/vector = 10); no bulk download. No tile proxy.
// Direct requests disclose IP/Referer/User-Agent to Thunderforest. Current DPA:
// central logs 45 days, transient copies 7 days. Never log keys or coordinates.
// No map-image export exists: share cards draw route geometry without tiles.
// If added later, printed attribution must be:
// Maps © www.thunderforest.com, Data © www.osm.org/copyright
router.get('/map-tiles', auth, (_req, res) => {
  const key = process.env.THUNDERFOREST_API_KEY;
  res.set('Cache-Control', 'no-store');
  res.json({
    THUNDERFOREST_API_KEY: typeof key === 'string' && key.length === 32 && /^[A-Za-z0-9]{32}$/.test(key) ? key : null,
  });
});

router.get('/build', auth, requireDiagnosticsAdmin, (req, res) => {
  res.json({
    backendVersion: backendPackage.version || 'unknown',
    railwayDeploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
    railwayEnvironment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'unknown',
    nodeEnv: process.env.NODE_ENV || 'development',
    generatedAt: new Date().toISOString(),
  });
});

module.exports = router;
