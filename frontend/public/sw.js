const CACHE = 'forge-v6';
const API_CACHE = 'forge-api-v2';
const API_GET_CACHE_PATHS = ['/api/user', '/api/workouts/recent'];
const DB_NAME = 'forge-offline-queue';
const DB_VERSION = 1;
const STORE_NAME = 'requests';

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
  event.waitUntil(Promise.all([
    precacheAppShell().catch((error) => {
      console.error('[service-worker/install] app shell precache failed:', error?.message || error);
      throw error;
    }),
    self.skipWaiting(),
  ]));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== API_CACHE).map((k) => caches.delete(k)))
    ),
    self.clients.claim(),
  ]));
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (error) {
    console.error('[service-worker/push] payload parse failed:', error?.message || error);
    payload = { title: 'Forged Hybrid', body: event.data?.text?.() || 'A new activity is ready to review.' };
  }
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
  return /^\/api\/races\/[^/]+\/removal-(?:preview|apply)$/.test(url.pathname)
    || /^\/api\/plans\/adaptation\/[^/]+\/(?:accept|keep)$/.test(url.pathname);
}

function isCacheableApiGet(request, url) {
  if (request.method.toUpperCase() !== 'GET') return false;
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

async function matchStatic(request) {
  const cache = await caches.open(CACHE);
  return cache.match(request, { ignoreVary: true });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

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
        if (response.ok && hasExpectedAssetType(url, response)) {
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
          return new Response('Asset unavailable offline', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
          });
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
