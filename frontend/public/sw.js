const CACHE = 'forge-v10';
const API_CACHE = 'forge-api-v2';
const API_GET_CACHE_PATHS = ['/api/user', '/api/workouts/recent'];
const DB_NAME = 'forge-offline-queue';
const DB_VERSION = 1;
const STORE_NAME = 'requests';
const SETUP_PROTOCOL = 'FORGE_WEB_PUSH_SETUP_V1';
const SETUP_REVISION = 'forge-push-setup-1';
const SETUP_BOOT = crypto.randomUUID();
const SETUP_DB = 'forge-push-setup-v1';
const SETUP_COPY = 'Open Forge to finish enabling notifications.';
const SETUP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SETUP_HASH = /^[0-9a-f]{64}$/;
const setupParticipants = new Map();
let setupClock = Date.now(), setupMono = performance.now();

function setupTime() {
  const now = performance.now();
  setupClock = Math.max(Date.now(), setupClock + Math.max(0, now - setupMono));
  setupMono = now;
  return setupClock;
}
function setupSecret(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try { return btoa(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '=')).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') === value; } catch { return false; }
}
async function setupHash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
function setupKeys(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
}
function validSetupPayload(payload) {
  const keys = ['title', 'body', 'url', 'notificationId', 'setup'];
  if (Object.hasOwn(payload || {}, 'type')) keys.push('type');
  if (!setupKeys(payload, keys) || (keys.includes('type') && payload.type !== SETUP_PROTOCOL)) return false;
  const p = payload.setup;
  return setupKeys(p, ['protocol', 'challengeId', 'operationId', 'clientNonceHash', 'authEpoch', 'endpointHash', 'secret', 'expiresAt'])
    && p.protocol === SETUP_PROTOCOL && SETUP_UUID.test(p.challengeId) && SETUP_UUID.test(p.operationId) && SETUP_UUID.test(p.authEpoch)
    && SETUP_HASH.test(p.clientNonceHash) && SETUP_HASH.test(p.endpointHash) && setupSecret(p.secret)
    && Number.isSafeInteger(p.expiresAt) && p.expiresAt >= 0
    && payload.title === 'Forged Hybrid' && payload.body === SETUP_COPY && payload.url === '/more'
    && payload.notificationId === `forge-push-setup:${p.challengeId}` && JSON.stringify(payload).length <= 8192;
}
function setupShaped(payload) {
  return payload && typeof payload === 'object' && (Object.hasOwn(payload, 'setup') || payload.type === SETUP_PROTOCOL
    || (typeof payload.notificationId === 'string' && payload.notificationId.startsWith('forge-push-setup:')));
}
async function setupStore(change) {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open(SETUP_DB, 1);
    let failed = false;
    r.onupgradeneeded = () => { if (failed) { r.transaction.abort(); return; } r.result.createObjectStore('operations', { keyPath: 'operationId' }); r.result.createObjectStore('proofs', { keyPath: 'challengeId' }); };
    r.onsuccess = () => { if (failed) r.result.close(); else resolve(r.result); };
    r.onerror = r.onblocked = () => { failed = true; reject(new Error('SETUP_STORAGE')); };
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(['operations', 'proofs'], 'readwrite');
      const a = tx.objectStore('operations'), b = tx.objectStore('proofs'), ar = a.getAll(), br = b.getAll();
      let count = 0, result;
      const ready = () => {
        if (++count !== 2) return;
        try {
          const now = setupTime();
          // Independent page/worker monotonic-clock samples need not be identical.
          const ops = ar.result.filter(o => Number.isFinite(o.expiresAt) && o.expiresAt > now && Number.isFinite(o.createdAt) && now - o.createdAt < 300000);
          for (const op of ops) if (op.admissionExpiresAt <= now) delete op.createAdmission;
          const proofs = br.result.filter(p => p.expiresAt > now && ops.some(o => o.operationId === p.operationId && o.authEpoch === p.authEpoch));
          result = change(ops, proofs, now);
          if (result?.then || ops.length > 3 || proofs.length > 3) throw new Error('SETUP_STORAGE');
          a.clear(); b.clear(); ops.forEach(o => a.put(o)); proofs.forEach(p => b.put(p));
        } catch { tx.abort(); }
      };
      ar.onsuccess = br.onsuccess = ready;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(new Error('SETUP_STORAGE'));
    });
  } finally { db.close(); }
}
async function setupWindow(source) {
  if (!source || source.type !== 'window' || typeof source.id !== 'string') return null;
  const current = await self.clients.get(source.id);
  if (!current || current.type !== 'window') return null;
  const url = new URL(current.url), scope = new URL(self.registration.scope);
  return url.origin === self.location.origin && url.href.startsWith(scope.href) ? current : null;
}
async function handleSetupMessage(event) {
  const port = event.ports?.[0], data = event.data;
  try {
    const client = await setupWindow(event.source);
    if (!client) return;
    if (data.type === 'FORGE_PUSH_SETUP_ERASE') {
      if (!SETUP_UUID.test(data.operationId) || !SETUP_UUID.test(data.authEpoch)) return;
      await setupStore((ops, proofs) => {
        for (let i = ops.length - 1; i >= 0; i--) if (ops[i].operationId === data.operationId && ops[i].authEpoch === data.authEpoch) ops.splice(i, 1);
        for (let i = proofs.length - 1; i >= 0; i--) if (proofs[i].operationId === data.operationId && proofs[i].authEpoch === data.authEpoch) proofs.splice(i, 1);
      });
      return;
    }
    if (!port) return;
    await setupStore(() => {});
    if (data.type === 'FORGE_PUSH_SETUP_HELLO') {
      if (!setupSecret(data.nonce)) return;
      if (setupParticipants.size >= 3 && !setupParticipants.has(client.id)) setupParticipants.delete(setupParticipants.keys().next().value);
      setupParticipants.set(client.id, { nonce: data.nonce, operationId: null });
      port.postMessage({ protocol: SETUP_PROTOCOL, nonce: data.nonce, revision: SETUP_REVISION, bootId: SETUP_BOOT, clientId: client.id });
      return;
    }
    const participant = setupParticipants.get(client.id);
    if (!participant || participant.nonce !== data.handshakeNonce || data.bootId !== SETUP_BOOT || data.protocol !== SETUP_PROTOCOL
      || !SETUP_UUID.test(data.operationId) || !SETUP_UUID.test(data.authEpoch) || !setupSecret(data.clientNonce)) return;
    const nonceHash = await setupHash(data.clientNonce);
    const operation = await setupStore(ops => structuredClone(ops.find(o => o.operationId === data.operationId && o.authEpoch === data.authEpoch && o.clientNonce === data.clientNonce) || null));
    if (!operation || operation.state === 'CONFIRMED') return;
    participant.operationId = operation.operationId;
    if (data.type === 'FORGE_PUSH_SETUP_WATCH') { port.postMessage({ protocol: SETUP_PROTOCOL, state: 'WATCHING' }); return; }
    if (data.type !== 'FORGE_PUSH_SETUP_HANDOFF' || !setupSecret(data.grant) || data.clientId !== client.id || data.challengeId !== operation.challengeId) return;
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 8000);
    let metadata;
    try {
      const response = await fetch('/push-setup/v1/redeem-handoff', { method: 'POST', cache: 'no-store', redirect: 'error', credentials: 'same-origin', signal: abort.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocol: SETUP_PROTOCOL, operationId: data.operationId, authEpoch: data.authEpoch,
          clientNonce: data.clientNonce, challengeId: data.challengeId, grant: data.grant, clientId: client.id }) });
      if (response.status !== 200 || !response.body) throw new Error('SETUP_HANDOFF');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let text = '', bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 2048) { await reader.cancel(); throw new Error('SETUP_HANDOFF'); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      metadata = JSON.parse(text);
    } finally { clearTimeout(timer); }
    if (!setupKeys(metadata, ['protocol', 'challengeId', 'operationId', 'clientId', 'authEpoch', 'clientNonceHash', 'endpointHash', 'expiresAt'])
      || metadata.protocol !== SETUP_PROTOCOL || metadata.operationId !== operation.operationId || metadata.challengeId !== data.challengeId
      || metadata.clientId !== client.id || metadata.authEpoch !== operation.authEpoch || metadata.clientNonceHash !== nonceHash
      || metadata.endpointHash !== operation.endpointHash || !Number.isSafeInteger(metadata.expiresAt) || metadata.expiresAt <= setupTime()) return;
    if (!await setupWindow(event.source) || setupParticipants.get(client.id) !== participant) return;
    await setupStore((ops, proofs, now) => {
      const op = ops.find(o => o.operationId === operation.operationId && o.authEpoch === operation.authEpoch && o.clientNonce === operation.clientNonce && o.challengeId === data.challengeId);
      const p = proofs.find(p => p.challengeId === data.challengeId && p.operationId === operation.operationId && p.authEpoch === operation.authEpoch && p.clientNonceHash === nonceHash && p.endpointHash === operation.endpointHash && p.expiresAt === metadata.expiresAt && p.expiresAt > now);
      if (op && p && setupParticipants.get(client.id) === participant) port.postMessage({ protocol: SETUP_PROTOCOL, challengeId: p.challengeId, secret: p.secret, expiresAt: p.expiresAt });
    });
  } catch { port?.postMessage({ protocol: SETUP_PROTOCOL, error: 'SETUP_UNAVAILABLE' }); }
  finally { port?.close(); }
}
async function handleSetupPush(payload) {
  const id = SETUP_UUID.test(payload?.setup?.challengeId) ? payload.setup.challengeId : null;
  const display = Promise.resolve().then(() => self.registration.showNotification('Forged Hybrid', { body: SETUP_COPY, icon: '/icon-192.png', badge: '/icon-192.png',
    tag: id ? `forge-push-setup:${id}` : 'forge-push-setup', data: { url: '/more', kind: 'push-setup', ...(id ? { challengeId: id } : {}) } })).catch(() => {});
  try {
    if (!validSetupPayload(payload)) return;
    const p = payload.setup;
    const nonceMatches = await setupStore(ops => structuredClone(ops.find(o => o.operationId === p.operationId && o.authEpoch === p.authEpoch) || null));
    if (!nonceMatches || await setupHash(nonceMatches.clientNonce) !== p.clientNonceHash) return;
    const accepted = await setupStore((ops, proofs, now) => {
      const op = ops.find(o => o.operationId === p.operationId && o.authEpoch === p.authEpoch && o.clientNonce === nonceMatches.clientNonce);
      if (!op || op.state === 'CONFIRMED' || op.endpointHash !== p.endpointHash || p.expiresAt <= now || (op.challengeId && op.challengeId !== p.challengeId)) return false;
      if (proofs.some(row => row.challengeId === p.challengeId && JSON.stringify(row) !== JSON.stringify({ challengeId: p.challengeId, operationId: p.operationId, clientNonceHash: p.clientNonceHash, authEpoch: p.authEpoch, endpointHash: p.endpointHash, secret: p.secret, expiresAt: p.expiresAt }))) return false;
      op.challengeId = p.challengeId; op.expiresAt = Math.min(op.expiresAt, p.expiresAt);
      if (!proofs.some(row => row.challengeId === p.challengeId)) proofs.push({ challengeId: p.challengeId, operationId: p.operationId, clientNonceHash: p.clientNonceHash, authEpoch: p.authEpoch, endpointHash: p.endpointHash, secret: p.secret, expiresAt: p.expiresAt });
      return true;
    });
    await display;
    const stillPending = accepted && await setupStore(ops => ops.some(op => op.operationId === p.operationId && op.authEpoch === p.authEpoch && op.challengeId === p.challengeId && op.state !== 'CONFIRMED'));
    if (stillPending) for (const [clientId, participant] of setupParticipants) if (participant.operationId === p.operationId) {
      const client = await self.clients.get(clientId);
      client?.postMessage({ type: 'SETUP_PROOF_AVAILABLE', challengeId: p.challengeId });
    }
  } catch { /* No payload, endpoint, or proof is ever logged. */ }
  finally { await display; }
}

async function precacheAppShell() {
  const cache = await caches.open(CACHE);
  const rootRequest = new Request(new URL('/', self.location.origin), { cache: 'reload' });
  const manifestRequest = new Request(new URL('/asset-manifest.json', self.location.origin), { cache: 'reload' });
  const shellResponse = await fetch(rootRequest);
  if (!shellResponse.ok) throw new Error(`App shell fetch failed (${shellResponse.status})`);
  const manifestResponse = await fetch(manifestRequest);
  if (!manifestResponse.ok) throw new Error(`Asset manifest fetch failed (${manifestResponse.status})`);

  const shellHtml = await shellResponse.clone().text();
  const manifest = await manifestResponse.clone().json();
  const shellAssetUrls = [...shellHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)]
    .map((match) => new URL(match[1], self.location.origin))
    .filter((url) => url.origin === self.location.origin && isCodeAsset(url));
  const manifestAssetUrls = Object.values(manifest || {}).flatMap((entry) => [
    entry?.file,
    ...(Array.isArray(entry?.css) ? entry.css : []),
  ]).filter(Boolean).map((assetPath) => new URL(assetPath, self.location.origin))
    .filter((url) => url.origin === self.location.origin && isCodeAsset(url));
  const assetUrls = [...new Set([...shellAssetUrls, ...manifestAssetUrls].map((url) => url.href))];

  await cache.put(rootRequest, shellResponse);
  await cache.put(manifestRequest, manifestResponse);
  await Promise.all(assetUrls.map(async (assetUrl) => {
    const assetRequest = new Request(assetUrl, { cache: 'reload' });
    const assetResponse = await fetch(assetRequest);
    if (!assetResponse.ok || !hasExpectedAssetType(new URL(assetUrl), assetResponse)) {
      throw new Error(`App shell asset fetch failed: ${assetUrl}`);
    }
    await cache.put(assetRequest, assetResponse);
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheAppShell().catch((error) => {
    console.error('[service-worker/install] app shell precache failed:', error?.message || error);
    throw error;
  }));
});

self.addEventListener('message', (event) => {
  if (typeof event.data?.type === 'string' && event.data.type.startsWith('FORGE_PUSH_SETUP_')) {
    event.waitUntil(handleSetupMessage(event));
    return;
  }
  if (event.data?.type === 'FORGE_GET_VERSION') {
    event.ports?.[0]?.postMessage({ type: 'FORGE_SW_VERSION', revision: CACHE });
    return;
  }
  if (event.data?.type === 'FORGE_ACTIVATE_UPDATE') {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== API_CACHE).map((k) => caches.delete(k)))
    ),
    self.clients.claim(),
    setupStore(() => {}).catch(() => {}),
  ]));
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (error) {
    const raw = event.data?.text?.() || '';
    if (/FORGE_WEB_PUSH_SETUP_V1|"setup"\s*:|forge-push-setup:/.test(raw)) {
      event.waitUntil(handleSetupPush({ setup: {} }));
      return;
    }
    console.error('[service-worker/push] payload parse failed:', error?.message || error);
    payload = { title: 'Forged Hybrid', body: event.data?.text?.() || 'A new activity is ready to review.' };
  }
  if (setupShaped(payload)) { event.waitUntil(handleSetupPush(payload)); return; }
  const title = String(payload.title || 'Forged Hybrid').slice(0, 80);
  const body = String(payload.body || 'A new activity is ready to review.').slice(0, 240);
  const url = typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/';
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.notificationId || payload.type || 'forged-hybrid-activity',
      data: { url },
    }),
    notifyClients('FORGED_NOTIFICATION_RECEIVED', { notificationId: payload.notificationId || null }),
  ]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.notification.data?.kind === 'push-setup') {
    event.waitUntil((async () => {
      const operation = await setupStore((ops) => ops.find(o => o.challengeId === event.notification.data.challengeId) || null).catch(() => null);
      if (operation) for (const [id, p] of setupParticipants) if (p.operationId === operation.operationId) {
        const client = await self.clients.get(id);
        if (client) return client.focus();
      }
      return self.clients.openWindow(new URL('/more', self.location.origin).href);
    })());
    return;
  }
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.location.origin));
    if (existing) {
      await existing.navigate(targetUrl);
      return existing.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open queue DB'));
  });
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Queue transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Queue transaction aborted'));
  });
}

async function getQueueCount() {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const count = await new Promise((resolve, reject) => {
    const req = store.count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error || new Error('Failed to count queued requests'));
  });
  await txPromise(tx);
  db.close();
  return count;
}

async function notifyClients(type, extra = {}) {
  const count = await getQueueCount().catch(() => 0);
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of clients) {
    client.postMessage({ type, queueCount: count, ...extra });
  }
}

async function queueMutationRequest(request) {
  const requestClone = request.clone();
  let rawBody = null;
  try {
    rawBody = await requestClone.text();
  } catch {
    rawBody = null;
  }

  const headers = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const db = await openDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.add({
    url: request.url,
    method: request.method,
    rawBody,
    headers,
    createdAt: Date.now(),
    source: 'service-worker',
  });
  await txPromise(tx);
  db.close();
  await notifyClients('OFFLINE_QUEUE_UPDATED');
}

function isApiMutation(request, url) {
  const method = request.method.toUpperCase();
  return url.pathname.startsWith('/api/') && (method === 'POST' || method === 'PUT' || method === 'PATCH');
}

function isReplayUnsafeMutation(request, url) {
  if (!isApiMutation(request, url)) return false;
  return /^\/api\/races\/[^/]+\/removal-(?:preview|apply|reset)$/.test(url.pathname)
    || /^\/api\/plans\/candidates\/[^/]+\/apply$/.test(url.pathname)
    || url.pathname === '/api/runs/missed'
    || url.pathname === '/api/plans/reschedule-missed'
    || url.pathname === '/api/plans/reconciliation/respond'
    || /^\/api\/plans\/adaptation\/[^/]+\/(?:accept|keep)$/.test(url.pathname);
}

function isCacheableApiGet(request, url) {
  if (request.method.toUpperCase() !== 'GET') return false;
  // Observation tickets and missed-session eligibility are fresh decisions,
  // never an offline cache authority or reusable signed response.
  if (url.pathname.startsWith('/api/plans/adaptation/') || url.pathname.startsWith('/api/plans/reconciliation/')
    || url.pathname === '/api/plans/missed-sessions') return false;
  return API_GET_CACHE_PATHS.some((path) => url.pathname.startsWith(path));
}

function variesByAuthorization(response) {
  return String(response.headers.get('vary') || '')
    .split(',')
    .some((value) => value.trim().toLowerCase() === 'authorization');
}

function hasExpectedAssetType(url, response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (url.pathname.endsWith('.js')) {
    return contentType.includes('javascript') || contentType.includes('ecmascript');
  }
  if (url.pathname.endsWith('.css')) return contentType.includes('text/css');
  return true;
}

function isCodeAsset(url) {
  return url.pathname.endsWith('.js') || url.pathname.endsWith('.css');
}

function unavailableAssetResponse() {
  return new Response('Asset unavailable offline', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
  });
}

async function matchStatic(request) {
  const cache = await caches.open(CACHE);
  return cache.match(request, { ignoreVary: true });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.origin === self.location.origin && url.pathname.startsWith('/push-setup/v1/')) {
    event.respondWith(fetch(new Request(event.request, { cache: 'no-store', redirect: 'error' })));
    return;
  }

  if (isReplayUnsafeMutation(event.request, url)) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (isApiMutation(event.request, url)) {
    event.respondWith(
      fetch(event.request)
        .catch(async () => {
          await queueMutationRequest(event.request);
          return new Response(JSON.stringify({ queued: true, offline: true }), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          });
        })
    );
    return;
  }

  if (isCacheableApiGet(event.request, url)) {
    event.respondWith(
      fetch(event.request)
        .then(async (response) => {
          if (response.ok && variesByAuthorization(response)) {
            try {
              const cache = await caches.open(API_CACHE);
              await cache.put(event.request, response.clone());
            } catch (error) {
              console.error('[service-worker/cache] API response write failed:', error?.message || error);
            }
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(API_CACHE);
          const cached = await cache.match(event.request);
          if (cached) return cached;
          return new Response(JSON.stringify({ error: 'Offline and no cached data available' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        })
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(async (response) => {
        if (isCodeAsset(url) && !hasExpectedAssetType(url, response)) {
          return unavailableAssetResponse();
        }
        if (response.ok) {
          try {
            const cache = await caches.open(CACHE);
            await cache.put(event.request, response.clone());
          } catch (error) {
            console.error('[service-worker/cache] static response write failed:', error?.message || error);
          }
        }
        return response;
      })
      .catch(async () => {
        const cached = await matchStatic(event.request);
        if (cached) return cached;
        if (isCodeAsset(url)) {
          return unavailableAssetResponse();
        }
        if (event.request.mode === 'navigate') {
          return matchStatic(new Request(new URL('/', self.location.origin)));
        }
        return new Response('Resource unavailable offline', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
        });
      })
  );
});
