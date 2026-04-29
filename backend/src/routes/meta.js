const router = require('express').Router();
const auth = require('../middleware/auth');
const { requireDiagnosticsAdmin } = require('./diagnostics');
const backendPackage = require('../../package.json');

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
