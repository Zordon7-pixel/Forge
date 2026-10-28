const { randomUUID } = require('node:crypto');
const { validateRoute, routeId, UserRouteError } = require('../lib/userRoutes');

// Identical additive DDL runs on SQLite and PostgreSQL. JSON remains bounded
// TEXT, as for the existing private planned-leg cache. No recorded-run link.
const DDL = [
`CREATE TABLE IF NOT EXISTS user_routes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  waypoints_json TEXT NOT NULL CHECK (length(waypoints_json) <= 16384),
  geometry_json TEXT NOT NULL CHECK (length(geometry_json) <= 1048576),
  legs_json TEXT NOT NULL CHECK (length(legs_json) <= 32768),
  distance_meters DOUBLE PRECISION NOT NULL CHECK (distance_meters BETWEEN 0 AND 1000000),
  target_distance_meters DOUBLE PRECISION CHECK (target_distance_meters BETWEEN 0 AND 1000000),
  elevation_json TEXT NOT NULL CHECK (length(elevation_json) <= 1024),
  display_json TEXT NOT NULL CHECK (length(display_json) <= 4096),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`,
'CREATE INDEX IF NOT EXISTS idx_user_routes_owner_updated ON user_routes(user_id, updated_at DESC, id);',
];
async function installUserRoutes(tx) {
  for (const sql of DDL) await tx.run(sql);
}
const notFound = () => { throw new UserRouteError('USER_ROUTE_NOT_FOUND', 404); };
function fromRow(row) {
  if (!row) notFound();
  try {
    return { id: routeId(row.id), kind: 'planned', schemaVersion: 1, provenanceTrust: 'client_declared',
      ...validateRoute({
        name: row.name, waypoints: JSON.parse(row.waypoints_json), geometry: JSON.parse(row.geometry_json),
        legs: JSON.parse(row.legs_json), distanceMeters: row.distance_meters,
        targetDistanceMeters: row.target_distance_meters, elevation: JSON.parse(row.elevation_json),
        display: JSON.parse(row.display_json),
      }), createdAt: row.created_at, updatedAt: row.updated_at };
  } catch {
    // Fail closed on corrupt persisted coordinates rather than exporting a
    // repaired/downsampled course or returning internal data in an error.
    throw new UserRouteError('USER_ROUTES_UNAVAILABLE', 503);
  }
}
const values = route => [route.name, JSON.stringify(route.waypoints), JSON.stringify(route.geometry),
  JSON.stringify(route.legs), route.distanceMeters, route.targetDistanceMeters,
  JSON.stringify(route.elevation), JSON.stringify(route.display)];
function createUserRoutesStore({ dbGet, dbAll, withUserMutation }) {
  const read = (get, owner, id) => get('SELECT * FROM user_routes WHERE id=? AND user_id=?', [id, owner]);
  return {
    async list(owner, { limit, offset }) {
      // No geometry in list pages: detail is explicitly fetched one route at a time.
      return dbAll(`SELECT id, name, distance_meters, target_distance_meters, elevation_json, display_json,
        created_at, updated_at FROM user_routes WHERE user_id=? ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`,
      [owner, limit, offset]);
    },
    async get(owner, id) { return fromRow(await read(dbGet, owner, routeId(id))); },
    async create(owner, body) {
      const route = validateRoute(body), id = randomUUID(), now = new Date().toISOString();
      return withUserMutation(owner, async tx => {
        await tx.run(`INSERT INTO user_routes
          (id,user_id,name,waypoints_json,geometry_json,legs_json,distance_meters,target_distance_meters,
           elevation_json,display_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, owner, ...values(route), now, now]);
        return fromRow(await read(tx.get, owner, id));
      });
    },
    async replace(owner, id, body) {
      id = routeId(id);
      const route = validateRoute(body);
      return withUserMutation(owner, async tx => {
        const result = await tx.run(`UPDATE user_routes SET name=?,waypoints_json=?,geometry_json=?,legs_json=?,
          distance_meters=?,target_distance_meters=?,elevation_json=?,display_json=?,updated_at=?
          WHERE id=? AND user_id=?`, [...values(route), new Date().toISOString(), id, owner]);
        if (result.changes !== 1) notFound();
        return fromRow(await read(tx.get, owner, id));
      });
    },
    async remove(owner, id) {
      id = routeId(id);
      return withUserMutation(owner, async tx => {
        const result = await tx.run('DELETE FROM user_routes WHERE id=? AND user_id=?', [id, owner]);
        if (result.changes !== 1) notFound();
      });
    },
  };
}
module.exports = { DDL, installUserRoutes, createUserRoutesStore };
