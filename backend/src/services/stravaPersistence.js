'use strict';
// Capture only a server-read connection before provider IO; persist only after
// acquiring the caller's owner transaction. This is the single shared importer,
// not a second background normalization/reconciliation implementation.
const { normalizeStravaRun, chooseMatchingHealthRun } = require('../lib/stravaActivity');
const { buildRunImportKeys } = require('../lib/runImportKey');
const autoUpdatePRs = require('./prAuto');
const { ensureSavedRunEvent } = require('./savedRunEvents');

const captures=new WeakSet();
function captureStravaConnection(userId,row) {
  if(!row || String(row.user_id)!==String(userId) || !row.connection_generation || !/^[1-9][0-9]{0,29}$/.test(String(row.athlete_id)))throw Object.assign(new Error('Strava connection unavailable'),{code:'STRAVA_CONNECTION_STALE'});
  const capture=Object.freeze({userId:String(userId),generation:row.connection_generation,athleteId:String(row.athlete_id)});
  captures.add(capture);return capture;
}
async function assertCurrentConnection(tx,userId,expected) {
  if(!captures.has(expected) || expected.userId!==String(userId))throw Object.assign(new Error('Strava connection unavailable'),{code:'STRAVA_CONNECTION_STALE'});
  const row=await tx.get(`SELECT t.connection_generation,t.athlete_id,b.id AS binding_id FROM strava_tokens t
    LEFT JOIN strava_ingress_bindings b ON b.id=t.connection_generation AND b.user_id=t.user_id
    WHERE t.user_id=?`,[userId]);
  if(!row || row.binding_id!==expected.generation || row.connection_generation!==expected.generation || String(row.athlete_id)!==expected.athleteId)throw Object.assign(new Error('Strava connection changed'),{code:'STRAVA_CONNECTION_STALE'});
}
async function findMatchingCanonicalRun(userId, incoming, query) {
  const candidates = await query.all(
    `SELECT id, duration_seconds, health_start_at, workout_metrics_json
     FROM runs
     WHERE user_id=? AND date=? AND health_source IN ('apple_health', 'forged_hybrid')
       AND ABS(COALESCE(distance_miles, 0) - ?) <= 0.10
       AND COALESCE(watch_normalized_type, type, '') NOT IN ('walk', 'walking')
     LIMIT 20`,
    [userId, incoming.date, incoming.distanceMiles]
  );
  return chooseMatchingHealthRun(candidates, incoming);
}

async function enrichRunFromStrava(userId, runId, incoming, query) {
  const routeJson = JSON.stringify(incoming.routeCoords);
  const row = await query.get(
    `SELECT route_coords, elevation_gain, perceived_effort, avg_heart_rate,
            calories, workout_metrics_json
     FROM runs WHERE id=? AND user_id=?`,
    [runId, userId]
  );
  if (!row) return { changes: 0 };

  let metrics = {};
  let canWriteMetrics = true;
  const storedMetrics = row?.workout_metrics_json;
  if (storedMetrics && typeof storedMetrics === 'object' && !Array.isArray(storedMetrics)) {
    metrics = storedMetrics;
  } else if (storedMetrics) {
    try {
      const parsed = JSON.parse(storedMetrics);
      metrics = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      console.error('[strava/sync] workout metrics parse failed:', err.message);
      canWriteMetrics = false;
    }
  }

  let storedRoute = [];
  try {
    const parsedRoute = Array.isArray(row.route_coords) ? row.route_coords : JSON.parse(row.route_coords || '[]');
    storedRoute = Array.isArray(parsedRoute) ? parsedRoute : [];
  } catch (err) {
    console.error('[strava/sync] stored route parse failed:', err.message);
  }

  const addRoute = storedRoute.length < 2 && incoming.routeCoords.length >= 2;
  const addElevation = (row.elevation_gain === null || row.elevation_gain === undefined || row.elevation_gain === '')
    && incoming.elevationGainFeet !== null;
  const addEffort = (row.perceived_effort === null || row.perceived_effort === undefined || row.perceived_effort === '')
    && incoming.perceivedEffort !== null;
  const addHeartRate = (row.avg_heart_rate === null || row.avg_heart_rate === undefined || row.avg_heart_rate === '')
    && incoming.averageHeartRate !== null;
  const addCalories = Number(row.calories || 0) <= 0 && incoming.calories > 0;
  if (!addRoute && !addElevation && !addEffort && !addHeartRate && !addCalories) return { changes: 0 };

  if (addRoute) metrics.route_enriched_from_strava = 1;
  if (addElevation) metrics.elevation_enriched_from_strava = 1;
  if (addEffort) metrics.workout_effort_user_rated = 1;
  metrics.strava_activity_id = incoming.activityId;
  return query.run(
    `UPDATE runs SET
       route_coords = CASE WHEN ?=1 THEN ? ELSE route_coords END,
       elevation_gain = CASE WHEN ?=1 THEN ? ELSE elevation_gain END,
       perceived_effort = CASE WHEN ?=1 THEN ? ELSE perceived_effort END,
       avg_heart_rate = CASE WHEN ?=1 THEN ? ELSE avg_heart_rate END,
       calories = CASE WHEN ?=1 THEN ? ELSE calories END,
       workout_metrics_json = CASE WHEN ?=1 THEN ? ELSE workout_metrics_json END
     WHERE id=? AND user_id=?`,
    [
      addRoute ? 1 : 0,
      routeJson,
      addElevation ? 1 : 0,
      incoming.elevationGainFeet,
      addEffort ? 1 : 0,
      incoming.perceivedEffort,
      addHeartRate ? 1 : 0,
      incoming.averageHeartRate,
      addCalories ? 1 : 0,
      incoming.calories,
      canWriteMetrics ? 1 : 0,
      JSON.stringify(metrics),
      runId,
      userId,
    ]
  );
}


async function persistStravaActivity(tx,userId,activity,expectedConnection) {
  await assertCurrentConnection(tx,userId,expectedConnection);
  if(!String(activity?.type || activity?.sport_type || '').toLowerCase().includes('run'))return {runId:null,imported:0,enriched:0,changed:false};
  const incoming=normalizeStravaRun(activity);
  if(!incoming.activityId)return {runId:null,imported:0,enriched:0,changed:false};
  const link=await tx.get("SELECT * FROM provider_activity_links WHERE user_id=? AND provider='strava' AND object_id=?",[userId,incoming.activityId]);
  if(link?.state==='USER_DELETED')return {runId:null,imported:0,enriched:0,changed:false};
  const keys=buildRunImportKeys({healthSource:'strava',sourceWorkoutId:incoming.activityId,startDate:incoming.startDate,type:'easy',watchActivityType:incoming.activityType,watchNormalizedType:'strava_run',distanceMiles:incoming.distanceMiles,durationSeconds:incoming.movingSeconds});
  for(const key of keys)if(await tx.get('SELECT id FROM run_import_tombstones WHERE user_id=? AND source_key=? LIMIT 1',[userId,key]))return {runId:null,imported:0,enriched:0,changed:false};
  let matchingCanonicalRun;
  if(link?.run_id) {
    matchingCanonicalRun=await tx.get('SELECT * FROM runs WHERE id=? AND user_id=?',[link.run_id,userId]);
    if(!matchingCanonicalRun)throw Object.assign(new Error('Owned provider link has no canonical run'),{code:'STRAVA_LINK_INVALID'});
  } else matchingCanonicalRun=await findMatchingCanonicalRun(userId,incoming,tx);
  let imported=0,enriched=0,runId;
  if(matchingCanonicalRun) {
    runId=matchingCanonicalRun.id;
    const update=await enrichRunFromStrava(userId,runId,incoming,tx);
    if(Number(update?.changes||0)>0)enriched=1;
  } else {
    runId=`strava_${userId}_${incoming.activityId}`;
    const routeJson=JSON.stringify(incoming.routeCoords);
    const workoutMetrics={metric_source:'strava'};
    if(incoming.routeCoords.length>=2)workoutMetrics.route_enriched_from_strava=1;
    if(incoming.elevationGainFeet!==null)workoutMetrics.elevation_enriched_from_strava=1;
    if(incoming.perceivedEffort!==null)workoutMetrics.workout_effort_user_rated=1;
    const insertResult=await tx.run(`INSERT INTO runs (
      id,user_id,date,type,distance_miles,duration_seconds,perceived_effort,
      calories,notes,watch_mode,watch_activity_type,watch_normalized_type,
      health_source,health_source_workout_id,health_start_at,health_end_at,
      avg_heart_rate,elevation_gain,route_coords,workout_metrics_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,[
      runId,userId,incoming.date,'easy',incoming.distanceMiles,incoming.movingSeconds,incoming.perceivedEffort,
      incoming.calories,`Imported from Strava: ${incoming.name}`,'strava',incoming.activityType,'strava_run',
      'strava',incoming.activityId,incoming.startDate,incoming.endDate,incoming.averageHeartRate,
      incoming.elevationGainFeet,routeJson,JSON.stringify(workoutMetrics),
    ]);
    if(Number(insertResult?.changes||0)>0)imported=1;
    else { const update=await enrichRunFromStrava(userId,runId,incoming,tx);if(Number(update?.changes||0)>0)enriched=1; }
  }
  const run=await tx.get('SELECT * FROM runs WHERE id=? AND user_id=?',[runId,userId]);
  if(!run)throw Object.assign(new Error('Canonical run missing'),{code:'STRAVA_RUN_MISSING'});
  await autoUpdatePRs(userId,run,{tx});
  await tx.run(`INSERT INTO provider_activity_links(user_id,provider,object_id,run_id,state)
    VALUES(?,'strava',?,?,'ACTIVE') ON CONFLICT(user_id,provider,object_id)
    DO UPDATE SET run_id=excluded.run_id,state='ACTIVE',updated_at=CURRENT_TIMESTAMP`,[userId,incoming.activityId,runId]);
  await ensureSavedRunEvent(tx,{userId,runId,providerStart:activity.start_date,providerType:activity.sport_type || activity.type});
  return {runId,run,imported,enriched,changed:Boolean(imported||enriched)};
}
module.exports={captureStravaConnection,persistStravaActivity};
