// Dedicated, short-lived setup state. Never use the offline request queue.
export const SETUP_DB = 'forge-push-setup-v1'
export const SETUP_TTL = 300000
export const SETUP_LIMIT = 3
let clockFloor = Date.now()
let clockSample = typeof performance === 'undefined' ? 0 : performance.now()

export function setupNow() {
  const mono = typeof performance === 'undefined' ? clockSample : performance.now()
  clockFloor = Math.max(Date.now(), clockFloor + Math.max(0, mono - clockSample))
  clockSample = mono
  return clockFloor
}

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SETUP_DB, 1)
    let failed = false
    request.onupgradeneeded = () => {
      if (failed) { request.transaction.abort(); return }
      request.result.createObjectStore('operations', { keyPath: 'operationId' })
      request.result.createObjectStore('proofs', { keyPath: 'challengeId' })
    }
    request.onerror = request.onblocked = () => { failed = true; reject(new Error('SETUP_STORAGE_UNAVAILABLE')) }
    request.onsuccess = () => { if (failed) request.result.close(); else resolve(request.result) }
  })
}

// All comparison and removal happens in one IDB transaction, including push/create races.
export async function setupTransaction(change) {
  const db = await open()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(['operations', 'proofs'], 'readwrite')
      const operations = tx.objectStore('operations')
      const proofs = tx.objectStore('proofs')
      const a = operations.getAll(), b = proofs.getAll()
      let result, ready = 0
      const loaded = () => {
        if (++ready !== 2) return
        try {
          const now = setupNow()
          // Page and worker monotonic clocks are sampled independently. A tiny
          // cross-realm offset must not delete a just-created operation; its fixed
          // absolute expiry and maximum age remain independently enforced.
          const ops = a.result.filter((op) => Number.isFinite(op.expiresAt) && op.expiresAt > now && Number.isFinite(op.createdAt) && now - op.createdAt < SETUP_TTL)
          for (const op of ops) if (op.admissionExpiresAt <= now) delete op.createAdmission
          const live = new Set(ops.map((op) => op.operationId))
          const rows = b.result.filter((proof) => proof.expiresAt > now && live.has(proof.operationId))
          result = change(ops, rows, now)
          if (result?.then) throw new Error('SETUP_ASYNC_TRANSACTION')
          // This dedicated database has no unrelated/training stores. Preserve exact rows
          // selected by the transaction, never delete a successor from a stale snapshot.
          operations.clear(); proofs.clear()
          for (const op of ops) operations.put(op)
          for (const proof of rows) proofs.put(proof)
        } catch { tx.abort() }
      }
      a.onsuccess = loaded; b.onsuccess = loaded
      tx.oncomplete = () => resolve(result)
      tx.onerror = tx.onabort = () => reject(new Error('SETUP_STORAGE_UNAVAILABLE'))
    })
  } finally { db.close() }
}

export const listSetupOperations = () => setupTransaction((ops) => structuredClone(ops))

export function putSetupOperation(operation) {
  return setupTransaction((ops, proofs, now) => {
    if (ops.some((op) => op.operationId === operation.operationId)) throw new Error('SETUP_OPERATION_CONFLICT')
    const evicted = []
    while (ops.length >= SETUP_LIMIT) {
      ops.sort((a, b) => a.createdAt - b.createdAt || a.operationId.localeCompare(b.operationId))
      evicted.push(ops.shift())
    }
    for (let i = proofs.length - 1; i >= 0; i--) if (evicted.some((op) => op.operationId === proofs[i].operationId)) proofs.splice(i, 1)
    ops.push({ ...operation, createdAt: now, expiresAt: Math.min(operation.expiresAt, now + SETUP_TTL) })
    return evicted
  })
}

export function updateSetupOperation(id, epoch, change) {
  return setupTransaction((ops, proofs) => {
    const op = ops.find((row) => row.operationId === id && row.authEpoch === epoch)
    if (!op) return null
    const result = change(op, proofs)
    return result === undefined ? structuredClone(op) : result
  })
}

export function eraseSetupOperation(id, epoch) {
  return setupTransaction((ops, proofs) => {
    const index = ops.findIndex((op) => op.operationId === id && op.authEpoch === epoch)
    if (index < 0) return false
    ops.splice(index, 1)
    for (let i = proofs.length - 1; i >= 0; i--) if (proofs[i].operationId === id && proofs[i].authEpoch === epoch) proofs.splice(i, 1)
    return true
  })
}

export function eraseSetupEpoch(epoch) {
  return setupTransaction((ops, proofs) => {
    const removed = ops.filter((op) => op.authEpoch === epoch)
    for (let i = ops.length - 1; i >= 0; i--) if (ops[i].authEpoch === epoch) ops.splice(i, 1)
    for (let i = proofs.length - 1; i >= 0; i--) if (proofs[i].authEpoch === epoch) proofs.splice(i, 1)
    return removed.map(({ operationId, authEpoch }) => ({ operationId, authEpoch }))
  })
}
