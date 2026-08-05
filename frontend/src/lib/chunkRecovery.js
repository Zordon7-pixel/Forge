const RECOVERY_KEY = 'forge_chunk_recovery_attempted'
const RECOVERY_CLEAR_MS = 15000

function errorText(error) {
  return `${error?.message || ''} ${error?.stack || ''}`.toLowerCase()
}

export function isRecoverableChunkError(error, { allowGenericLoadFailure = false } = {}) {
  const text = errorText(error)
  const strongChunkSignals = [
    'failed to fetch dynamically imported module',
    'error loading dynamically imported module',
    'importing a module script failed',
    'module script load failed',
    'is not a valid javascript mime type',
    'strict mime type checking is enforced',
    'chunkloaderror',
    'loading chunk',
    'vite:preloaderror',
  ]

  return strongChunkSignals.some((needle) => text.includes(needle))
    || (allowGenericLoadFailure && text.includes('load failed'))
}

export function recoverFromChunkError(error, options) {
  if (typeof window === 'undefined' || !isRecoverableChunkError(error, options)) return false

  try {
    if (window.sessionStorage.getItem(RECOVERY_KEY) === '1') return false
    window.sessionStorage.setItem(RECOVERY_KEY, '1')
  } catch (storageError) {
    console.warn('[chunkRecovery] session flag unavailable:', storageError?.message || storageError)
    return false
  }

  const url = new URL(window.location.href)
  url.searchParams.set('_forge_reload', String(Date.now()))
  window.location.replace(url.toString())
  return true
}

export function installChunkRecovery() {
  if (typeof window === 'undefined') return

  window.setTimeout(() => {
    try {
      window.sessionStorage.removeItem(RECOVERY_KEY)
    } catch (error) {
      console.warn('[chunkRecovery] session flag cleanup failed:', error?.message || error)
    }
  }, RECOVERY_CLEAR_MS)

  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault()
    recoverFromChunkError(event.payload || new Error('vite:preloadError'))
  })

  window.addEventListener('unhandledrejection', (event) => {
    if (recoverFromChunkError(event.reason)) {
      event.preventDefault()
    }
  })
}
