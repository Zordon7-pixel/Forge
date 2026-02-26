const DB_NAME = 'forge-offline-queue'
const DB_VERSION = 1
const STORE_NAME = 'requests'

function hasWindow() {
  return typeof window !== 'undefined'
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Failed to open offline queue DB'))
  })
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'))
  })
}

async function notifyQueueUpdated() {
  if (!hasWindow()) return
  const count = await getQueueCount()
  window.dispatchEvent(new CustomEvent('offline-queue-updated', { detail: { count } }))
}

export async function queueRequest(url, method, body) {
  if (typeof indexedDB === 'undefined') return
  const db = await openDb()
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)
  store.add({
    url,
    method: String(method || 'POST').toUpperCase(),
    body: body ?? null,
    createdAt: Date.now(),
  })
  await txPromise(tx)
  db.close()
  await notifyQueueUpdated()
}

function buildHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  if (hasWindow()) {
    const token = localStorage.getItem('forge_token')
    if (token) headers.Authorization = `Bearer ${token}`
  }
  return headers
}

export async function flushQueue() {
  if (typeof indexedDB === 'undefined') return 0
  if (hasWindow() && !navigator.onLine) return 0

  const db = await openDb()
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)
  const list = await new Promise((resolve, reject) => {
    const req = store.getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error || new Error('Failed to read offline queue'))
  })

  list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
  let flushedCount = 0

  for (const item of list) {
    try {
      const itemHeaders = item.headers && typeof item.headers === 'object' ? item.headers : {}
      const response = await fetch(item.url, {
        method: item.method || 'POST',
        headers: { ...itemHeaders, ...buildHeaders() },
        body: item.rawBody != null
          ? item.rawBody
          : item.body != null
            ? JSON.stringify(item.body)
            : undefined,
      })
      if (response.ok) {
        store.delete(item.id)
        flushedCount += 1
      }
    } catch {
      break
    }
  }

  await txPromise(tx)
  db.close()
  await notifyQueueUpdated()

  if (hasWindow() && flushedCount > 0) {
    window.dispatchEvent(new CustomEvent('offline-queue-flushed', { detail: { flushedCount } }))
  }

  return flushedCount
}

export async function getQueueCount() {
  if (typeof indexedDB === 'undefined') return 0
  const db = await openDb()
  const tx = db.transaction(STORE_NAME, 'readonly')
  const store = tx.objectStore(STORE_NAME)
  const count = await new Promise((resolve, reject) => {
    const req = store.count()
    req.onsuccess = () => resolve(req.result || 0)
    req.onerror = () => reject(req.error || new Error('Failed to count offline queue'))
  })
  await txPromise(tx)
  db.close()
  return count
}
