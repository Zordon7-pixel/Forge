'use strict';
const { randomUUID } = require('node:crypto');
const { normalizeWebhookEvent, safeWebhookId } = require('../lib/stravaWebhook');
const { getIntakeTransaction } = require('../db/backgroundSyncIntake');
const error = (code, status = 503) => Object.assign(new Error(code), { code, status });

async function storeHint(tx, event) {
  const lock = tx.dialect === 'sqlite' ? '' : ' FOR UPDATE';
  const binding = await tx.get(`SELECT id FROM strava_ingress_bindings WHERE athlete_id=?${lock}`, [event.ownerId]);
  if (!binding) return { received: true, ignored: true };
  const prior = await tx.get(`SELECT * FROM provider_event_jobs WHERE binding_id=? AND object_type=? AND object_id=?${lock}`,
    [binding.id, event.objectType, event.objectId]);
  if (prior?.last_fingerprint === event.fingerprint) return { received: true };
  const clock = await tx.get(tx.dialect === 'sqlite' ? "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now" : 'SELECT clock_timestamp() AS now');
  const now = new Date(clock.now).getTime();
  if (!Number.isFinite(now)) throw error('STRAVA_INTAKE_CLOCK_UNAVAILABLE');
  if (prior) {
    const revision = Number(prior.requested_revision);
    if (!Number.isSafeInteger(revision) || revision >= 8999999999999999) throw error('STRAVA_INTAKE_REVISION_EXHAUSTED');
    const fetched = prior.last_fetch_at === null ? null : new Date(prior.last_fetch_at).getTime();
    if (fetched !== null && !Number.isFinite(fetched)) throw error('STRAVA_INTAKE_CLOCK_UNAVAILABLE');
    const due = Math.max(now, fetched === null ? now : fetched + 30000);
    const revive = prior.state === 'DEAD' && event.eventTime > Number(prior.reported_event_time)
      && now >= Math.max(fetched || 0, new Date(prior.updated_at).getTime()) + 30000;
    // Leased callbacks do not touch lease/due/fetch/processed fields. A stale
    // DEAD hint is retained but cannot restart a failed episode.
    if (prior.state === 'LEASED' || prior.state === 'DEAD' && !revive) {
      await tx.run('UPDATE provider_event_jobs SET requested_revision=?,last_fingerprint=?,reported_event_time=?,last_aspect=?,updated_at=? WHERE id=?',
        [revision + 1, event.fingerprint, Math.max(event.eventTime, Number(prior.reported_event_time)), event.aspectType,
          prior.state === 'DEAD' ? prior.updated_at : new Date(now).toISOString(), prior.id]);
    } else {
      const previousDue = new Date(prior.available_at).getTime();
      const available = prior.state === 'PENDING' || prior.state === 'RETRY'
        ? Math.max(fetched === null ? 0 : fetched + 30000, Math.min(previousDue, due)) : due;
      await tx.run("UPDATE provider_event_jobs SET requested_revision=?,last_fingerprint=?,reported_event_time=?,last_aspect=?,updated_at=?,state='PENDING',available_at=?,attempts=?,last_error_code=NULL WHERE id=?",
        [revision + 1, event.fingerprint, Math.max(event.eventTime, Number(prior.reported_event_time)), event.aspectType,
          new Date(now).toISOString(), new Date(available).toISOString(), revive ? 0 : prior.attempts, prior.id]);
    }
    return { received: true };
  }
  const owned = await tx.get('SELECT count(*) AS n FROM (SELECT id FROM provider_event_jobs WHERE binding_id=? LIMIT 101) AS slots', [binding.id]);
  if (Number(owned.n) >= 100) throw error('STRAVA_INTAKE_CAPACITY');
  if (!await tx.get(`SELECT id FROM background_sync_control WHERE id='strava'${lock}`)) throw error('STRAVA_INTAKE_UNAVAILABLE');
  const global = await tx.get('SELECT count(*) AS n FROM (SELECT id FROM provider_event_jobs LIMIT 10001) AS slots');
  if (Number(global.n) >= 10000) throw error('STRAVA_INTAKE_CAPACITY');
  await tx.run(`INSERT INTO provider_event_jobs(id,binding_id,object_type,object_id,last_fingerprint,reported_event_time,last_aspect,available_at,state)
    VALUES(?,?,?,?,?,?,?,?,'PENDING')`, [randomUUID(), binding.id, event.objectType, event.objectId, event.fingerprint, event.eventTime, event.aspectType, new Date(now).toISOString()]);
  return { received: true };
}

function createStravaEventIntake({ transaction = getIntakeTransaction(), subscriptionId = process.env.STRAVA_WEBHOOK_SUBSCRIPTION_ID } = {}) {
  return async (body, options = {}) => {
    const event = normalizeWebhookEvent(body);
    if (!event) throw error('STRAVA_WEBHOOK_INVALID', 400);
    const expected = safeWebhookId(subscriptionId);
    if (!expected) throw error('STRAVA_WEBHOOK_CONFIG_UNAVAILABLE');
    // This is a routing/filter binding, NOT callback authentication.
    if (event.subscriptionId !== expected) throw error('STRAVA_WEBHOOK_SUBSCRIPTION_MISMATCH', 400);
    return transaction(tx => storeHint(tx, event), options);
  };
}
module.exports = { createStravaEventIntake, storeHint };
