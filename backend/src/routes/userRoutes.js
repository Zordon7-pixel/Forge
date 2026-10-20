const express = require('express');
const auth = require('../middleware/auth');
const { createUserRoutesStore } = require('../db/userRoutesStore');
const { MAX_BYTES, UserRouteError, pagination, routeId, toGpx } = require('../lib/userRoutes');

function createRouter(store = createUserRoutesStore(require('../db'))) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Authorization');
    next();
  });
  router.use(auth);
  router.use((req, res, next) => {
    if (['POST', 'PUT'].includes(req.method) && !req.is('application/json')) {
      return res.status(400).json({ error: 'INVALID_USER_ROUTE' });
    }
    if (!(req.method === 'GET' && req.path === '/') && Object.keys(req.query).length) {
      return res.status(400).json({ error: 'INVALID_USER_ROUTE' });
    }
    next();
  });
  router.use(express.json({ limit: MAX_BYTES, strict: true, inflate: false }));
  const handle = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
      // SQL/provider/request text may contain locations; never log or reflect it.
      res.status(err instanceof UserRouteError ? err.status : 503)
        .json({ error: err instanceof UserRouteError ? err.code : 'USER_ROUTES_UNAVAILABLE' });
    }
  };
  router.get('/', handle(async (req, res) => {
    const page = pagination(req.query);
    const rows = await store.list(req.user.id, page);
    res.json({ routes: rows.map(row => ({
      id: row.id, kind: 'planned', schemaVersion: 1, provenanceTrust: 'client_declared',
      name: row.name, distanceMeters: row.distance_meters, targetDistanceMeters: row.target_distance_meters,
      elevation: JSON.parse(row.elevation_json), display: JSON.parse(row.display_json),
      createdAt: row.created_at, updatedAt: row.updated_at,
    })), ...page });
  }));
  router.post('/', handle(async (req, res) => {
    const route = await store.create(req.user.id, req.body);
    res.location(`/api/user-routes/${route.id}`).status(201).json({ route });
  }));
  router.get('/:id/gpx', handle(async (req, res) => {
    const id = routeId(req.params.id);
    const route = await store.get(req.user.id, id);
    // Only a server-generated, validated identifier enters the header. The
    // user-provided name is escaped XML content, never a file path/header.
    res.set('Content-Disposition', `attachment; filename="planned-route-${id}.gpx"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.type('application/gpx+xml').send(toGpx(route));
  }));
  router.get('/:id', handle(async (req, res) => {
    res.json({ route: await store.get(req.user.id, req.params.id) });
  }));
  router.put('/:id', handle(async (req, res) => {
    res.json({ route: await store.replace(req.user.id, req.params.id, req.body) });
  }));
  router.delete('/:id', handle(async (req, res) => {
    await store.remove(req.user.id, req.params.id);
    res.status(204).end();
  }));
  router.use((_req, res) => res.status(404).json({ error: 'USER_ROUTE_NOT_FOUND' }));
  router.use((err, _req, res, _next) => {
    const status = err.type === 'entity.too.large' ? 413 : err instanceof URIError || err.type ? 400 : 503;
    res.status(status).json({ error: status === 503 ? 'USER_ROUTES_UNAVAILABLE' : 'INVALID_USER_ROUTE' });
  });
  return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;
