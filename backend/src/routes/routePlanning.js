const express = require('express');
const auth = require('../middleware/auth');
const { createPlanner, PlanningError } = require('../services/plannedLeg');
const { createPlanningStore } = require('../db/plannedLegStore');

function createRouter(plan = createPlanner({ store: createPlanningStore(require('../db')) })) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Authorization');
    next();
  });
  router.post('/leg', auth, (req, res, next) => {
    if (Object.keys(req.query).length || !req.is('application/json')) return res.status(400).json({ error: 'INVALID_LEG' });
    next();
  }, express.json({ limit: 1024, strict: true, inflate: false }), async (req, res) => {
    try {
      res.json(await plan(req.user.id, req.body));
    } catch (err) {
      const known = err instanceof PlanningError;
      if (known && err.retryAfter) res.set('Retry-After', String(err.retryAfter));
      res.status(known ? err.status : 503).json({ error: known ? err.code : 'PLANNING_UNAVAILABLE' });
    }
  });
  router.use((err, _req, res, _next) => {
    res.status(err.type === 'entity.too.large' ? 413 : 400).json({ error: 'INVALID_LEG' });
  });
  return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;
