const CACHE = 'forge-v3';
const API_CACHE = 'forge-api-v1';
const STATIC = ['/'];
const API_GET_CACHE_PATHS = ['/api/user', '/api/workouts/recent'];
const DB_NAME = 'forge-offline-queue';
const DB_VERSION = 1;
const STORE_NAME = 'requests';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== API_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
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

function isCacheableApiGet(request, url) {
  if (request.method.toUpperCase() !== 'GET') return false;
  return API_GET_CACHE_PATHS.some((path) => url.pathname.startsWith(path));
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

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
        .then((response) => {
          if (response.ok) {
            caches.open(API_CACHE).then((cache) => cache.put(event.request, response.clone()));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
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
      .then((response) => {
        if (response.ok) {
          caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/')))
  );
});
