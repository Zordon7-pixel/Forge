import { ACTIVE_RUN_SESSION_KEY } from './activeRunSession.js'
import { POST_RUN_CHECKIN_DRAFT_KEY } from './postRunCheckInDraft.js'
import { RUN_COMPLETION_HANDOFF_KEY, RUN_COMPLETION_PHASE } from './runCompletionHandoff.js'

export const SERVICE_WORKER_UPDATE_EVENT = 'forge:service-worker-update-state'
export const API_MUTATION_STATE_EVENT = 'forge:api-mutation-state'

const RELOAD_MARKER_KEY = 'forge_sw_reloaded_revision_v1'
const UPDATE_CHECK_MIN_INTERVAL_MS = 30_000
const VERSION_RESPONSE_TIMEOUT_MS = 1_500
const ACTIVATION_TIMEOUT_MS = 10_000
const ACTIVE_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000
const PROTECTED_ROUTES = [
  /^\/run\/active(?:\/|$)/,
  /^\/workout\/active(?:\/|$)/,
  /^\/run\/treadmill(?:\/|$)/,
  /^\/stretches\/session(?:\/|$)/,
]
const PROTECTED_HANDOFF_PHASES = new Set([
  RUN_COMPLETION_PHASE.RECORDING,
  RUN_COMPLETION_PHASE.SAVING,
  RUN_COMPLETION_PHASE.CHECKIN_PENDING,
])

const IDLE_SNAPSHOT = Object.freeze({
  phase: 'idle',
  actionRequired: false,
  reason: null,
  revision: null,
})

function storageValue(storage, key) {
  if (!storage || typeof storage.getItem !== 'function') throw new Error('storage unavailable')
  return storage.getItem(key)
}

function hasProtectedActiveRun(storage, now) {
  const raw = storageValue(storage, ACTIVE_RUN_SESSION_KEY)
  if (!raw) return false
  const session = JSON.parse(raw)
  const savedAt = Number(session?.savedAt || session?.startedAt || 0)
  if (!['running', 'paused', 'awaiting_distance'].includes(session?.phase)) return true
  if (!Number.isFinite(savedAt) || savedAt <= 0 || savedAt - now > 60_000) return true
  return now - savedAt <= ACTIVE_RUN_MAX_AGE_MS
}

function hasProtectedRunHandoff(storage) {
  const raw = storageValue(storage, RUN_COMPLETION_HANDOFF_KEY)
  if (!raw) return false
  const handoff = JSON.parse(raw)
  return PROTECTED_HANDOFF_PHASES.has(handoff?.phase)
}

function isDirtyControl(control) {
  if (!control || control.disabled || control.readOnly || control.type === 'hidden') return false
  const tagName = String(control.tagName || '').toLowerCase()
  const type = String(control.type || '').toLowerCase()
  if (type === 'checkbox' || type === 'radio') return Boolean(control.checked) !== Boolean(control.defaultChecked)
  if (tagName === 'select') {
    return Array.from(control.options || []).some((option) => Boolean(option.selected) !== Boolean(option.defaultSelected))
  }
  return String(control.value || '') !== String(control.defaultValue || '')
}

function isTrackableControl(control) {
  const tagName = String(control?.tagName || '').toLowerCase()
  return ['input', 'textarea', 'select'].includes(tagName) && !control.disabled && !control.readOnly && control.type !== 'hidden'
}

function currentControlState(control) {
  const tagName = String(control?.tagName || '').toLowerCase()
  const type = String(control?.type || '').toLowerCase()
  if (type === 'checkbox' || type === 'radio') return Boolean(control.checked)
  if (tagName === 'select') return Array.from(control.options || []).map((option) => Boolean(option.selected))
  return String(control?.value || '')
}

function defaultControlState(control) {
  const tagName = String(control?.tagName || '').toLowerCase()
  const type = String(control?.type || '').toLowerCase()
  if (type === 'checkbox' || type === 'radio') return Boolean(control.defaultChecked)
  if (tagName === 'select') return Array.from(control.options || []).map((option) => Boolean(option.defaultSelected))
  return String(control?.defaultValue || '')
}

function controlStatesMatch(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => value === right[index])
  }
  return left === right
}

function documentSafety(documentRef) {
  if (!documentRef || documentRef.readyState !== 'complete') return { safe: false, reason: 'document-not-ready' }
  if (documentRef.querySelector('[data-forge-reload-protected="true"], [role="dialog"], [aria-modal="true"]')) {
    return { safe: false, reason: 'protected-interaction' }
  }
  const controls = documentRef.querySelectorAll('input, textarea, select')
  if (Array.from(controls || []).some(isDirtyControl)) return { safe: false, reason: 'unsaved-interaction' }
  const editable = documentRef.querySelectorAll('[contenteditable="true"]')
  if (Array.from(editable || []).some((element) => String(element.textContent || '').trim().length > 0)) {
    return { safe: false, reason: 'unsaved-interaction' }
  }
  return { safe: true, reason: null }
}

export function reloadSafety({
  pathname = '',
  document: documentRef,
  localStorage: localStorageRef,
  hasPendingMutation = () => false,
  hasUnsavedInteraction = () => false,
  now = Date.now(),
} = {}) {
  if (PROTECTED_ROUTES.some((pattern) => pattern.test(String(pathname)))) {
    return { safe: false, reason: 'active-interaction' }
  }
  try {
    if (hasProtectedActiveRun(localStorageRef, now)) return { safe: false, reason: 'active-run' }
    if (hasProtectedRunHandoff(localStorageRef)) return { safe: false, reason: 'run-handoff' }
    if (storageValue(localStorageRef, POST_RUN_CHECKIN_DRAFT_KEY)) return { safe: false, reason: 'post-run-draft' }
  } catch {
    return { safe: false, reason: 'safety-state-unavailable' }
  }
  try {
    if (hasPendingMutation()) return { safe: false, reason: 'pending-mutation' }
  } catch {
    return { safe: false, reason: 'safety-state-unavailable' }
  }
  try {
    if (hasUnsavedInteraction()) return { safe: false, reason: 'unsaved-interaction' }
  } catch {
    return { safe: false, reason: 'safety-state-unavailable' }
  }
  return documentSafety(documentRef)
}

function safetyNeedsUserAction(reason) {
  return !['document-not-ready', 'pending-mutation'].includes(reason)
}

function fallbackRevision(worker) {
  try {
    const url = new URL(worker?.scriptURL || '', 'https://forge.invalid')
    return url.searchParams.get('revision') || url.searchParams.get('v') || url.pathname || 'unknown-worker'
  } catch {
    return 'unknown-worker'
  }
}

export class ServiceWorkerUpdateManager {
  constructor({
    window: windowRef,
    document: documentRef,
    serviceWorker,
    localStorage: localStorageRef,
    sessionStorage: sessionStorageRef,
    location,
    hasPendingMutation = () => false,
    capacitorApp = null,
    nativeRuntime = false,
    now = () => Date.now(),
    setTimeout: setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
    clearTimeout: clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
    minCheckIntervalMs = UPDATE_CHECK_MIN_INTERVAL_MS,
    versionTimeoutMs = VERSION_RESPONSE_TIMEOUT_MS,
    activationTimeoutMs = ACTIVATION_TIMEOUT_MS,
    logger = console,
  } = {}) {
    this.window = windowRef
    this.document = documentRef
    this.serviceWorker = serviceWorker
    this.localStorage = localStorageRef
    this.sessionStorage = sessionStorageRef
    this.location = location
    this.hasPendingMutation = hasPendingMutation
    this.capacitorApp = capacitorApp
    this.nativeRuntime = nativeRuntime
    this.now = now
    this.setTimeout = setTimeoutFn
    this.clearTimeout = clearTimeoutFn
    this.minCheckIntervalMs = minCheckIntervalMs
    this.versionTimeoutMs = versionTimeoutMs
    this.activationTimeoutMs = activationTimeoutMs
    this.logger = logger
    this.registration = null
    this.waitingWorker = null
    this.updateInFlight = null
    this.activationInFlight = null
    this.activationRevision = null
    this.pendingReloadRevision = null
    this.activationTimer = null
    this.lastCheckAt = null
    this.reloaded = false
    this.snapshot = { ...IDLE_SNAPSHOT }
    this.listenerHandles = []
    this.controlBaselines = new WeakMap()
    this.dirtyControls = new Set()
    this.started = false

    this.onControllerChange = () => this.handleControllerChange()
    this.onVisibilityChange = () => {
      if (this.document?.visibilityState === 'visible') this.handleForeground('visibility')
    }
    this.onPageShow = () => this.handleForeground('pageshow')
    this.onMutationState = () => this.retryPendingUpdate()
    this.onControlInput = (event) => this.trackControlInput(event?.target)
  }

  getSnapshot() {
    return { ...this.snapshot }
  }

  emit(phase, extra = {}) {
    this.snapshot = {
      phase,
      actionRequired: false,
      reason: null,
      revision: this.activationRevision || this.pendingReloadRevision || null,
      ...extra,
    }
    this.window?.dispatchEvent?.(new CustomEvent(SERVICE_WORKER_UPDATE_EVENT, { detail: this.getSnapshot() }))
    this.logger?.info?.(`[service-worker/update] ${phase}`, {
      reason: this.snapshot.reason,
      revision: this.snapshot.revision,
    })
  }

  currentSafety() {
    return reloadSafety({
      pathname: this.location?.pathname || '',
      document: this.document,
      localStorage: this.localStorage,
      hasPendingMutation: this.hasPendingMutation,
      hasUnsavedInteraction: () => this.hasTrackedUnsavedInteraction(),
      now: this.now(),
    })
  }

  trackControlInput(control) {
    if (!isTrackableControl(control)) {
      this.dirtyControls.delete(control)
      return
    }
    if (!this.controlBaselines.has(control)) {
      // Capture runs before framework handlers. Controlled React inputs may update
      // defaultValue to the typed value after the event, so retain the pre-edit baseline.
      this.controlBaselines.set(control, defaultControlState(control))
    }
    if (controlStatesMatch(currentControlState(control), this.controlBaselines.get(control))) {
      this.dirtyControls.delete(control)
    } else {
      this.dirtyControls.add(control)
    }
  }

  hasTrackedUnsavedInteraction() {
    for (const control of this.dirtyControls) {
      if (control?.isConnected === false || !isTrackableControl(control)) {
        this.dirtyControls.delete(control)
        continue
      }
      if (controlStatesMatch(currentControlState(control), this.controlBaselines.get(control))) {
        this.dirtyControls.delete(control)
        continue
      }
      return true
    }
    return false
  }

  async start() {
    if (this.started || !this.serviceWorker?.register) return this
    this.started = true
    this.serviceWorker.addEventListener?.('controllerchange', this.onControllerChange)
    this.document?.addEventListener?.('visibilitychange', this.onVisibilityChange)
    this.window?.addEventListener?.('load', this.onPageShow)
    this.window?.addEventListener?.('pageshow', this.onPageShow)
    this.window?.addEventListener?.(API_MUTATION_STATE_EVENT, this.onMutationState)
    this.document?.addEventListener?.('input', this.onControlInput, true)
    this.document?.addEventListener?.('change', this.onControlInput, true)
    this.installNativeLifecycleListeners()

    try {
      this.registration = await this.serviceWorker.register('/sw.js')
      this.observeRegistration(this.registration)
      await this.checkForUpdate('initial', { force: true })
    } catch (error) {
      this.logger?.warn?.('[service-worker/update] registration failed:', error?.message || error)
      this.emit('registration-failed')
    }
    return this
  }

  installNativeLifecycleListeners() {
    if (!this.nativeRuntime || !this.capacitorApp?.addListener) return
    const add = (eventName, callback) => {
      try {
        Promise.resolve(this.capacitorApp.addListener(eventName, callback))
          .then((handle) => {
            if (handle) this.listenerHandles.push(handle)
          })
          .catch((error) => this.logger?.warn?.('[service-worker/update] native listener failed:', error?.message || error))
      } catch (error) {
        this.logger?.warn?.('[service-worker/update] native listener failed:', error?.message || error)
      }
    }
    add('appStateChange', ({ isActive } = {}) => {
      if (isActive) this.handleForeground('appStateChange')
    })
    add('resume', () => this.handleForeground('resume'))
  }

  observeRegistration(registration) {
    if (!registration) return
    const observeInstalling = (worker) => {
      if (!worker) return
      this.emit('installing')
      const onStateChange = () => {
        this.emit(`installing-${worker.state || 'unknown'}`)
        if (worker.state === 'installed' && this.serviceWorker?.controller) this.considerWaitingWorker(worker)
      }
      worker.addEventListener?.('statechange', onStateChange)
      if (worker.state === 'installed' && this.serviceWorker?.controller) this.considerWaitingWorker(worker)
    }
    registration.addEventListener?.('updatefound', () => {
      this.emit('updatefound')
      observeInstalling(registration.installing)
    })
    observeInstalling(registration.installing)
    if (registration.waiting && this.serviceWorker?.controller) this.considerWaitingWorker(registration.waiting)
  }

  handleForeground(source) {
    this.emit('foreground-check', { source })
    this.retryPendingUpdate()
    void this.checkForUpdate(source)
  }

  async checkForUpdate(source, { force = false } = {}) {
    if (!this.registration?.update) return null
    const now = this.now()
    if (!force && this.lastCheckAt !== null && now - this.lastCheckAt < this.minCheckIntervalMs) {
      this.emit('update-check-deduped', { source })
      return this.updateInFlight
    }
    if (this.updateInFlight) return this.updateInFlight
    this.lastCheckAt = now
    this.emit('update-check', { source })
    this.updateInFlight = Promise.resolve()
      .then(() => this.registration.update())
      .then(() => {
        if (this.registration.waiting && this.serviceWorker?.controller) {
          return this.considerWaitingWorker(this.registration.waiting)
        }
        return null
      })
      .catch((error) => {
        this.logger?.warn?.('[service-worker/update] update check failed:', error?.message || error)
        this.emit('update-check-failed', { source })
        return null
      })
      .finally(() => {
        this.updateInFlight = null
      })
    return this.updateInFlight
  }

  async workerRevision(worker) {
    if (!worker?.postMessage || typeof MessageChannel === 'undefined') return fallbackRevision(worker)
    return new Promise((resolve) => {
      const channel = new MessageChannel()
      let settled = false
      const finish = (revision) => {
        if (settled) return
        settled = true
        this.clearTimeout?.(timer)
        channel.port1.close?.()
        channel.port2.close?.()
        resolve(String(revision || fallbackRevision(worker)))
      }
      const timer = this.setTimeout?.(() => finish(fallbackRevision(worker)), this.versionTimeoutMs)
      channel.port1.onmessage = (event) => {
        if (event?.data?.type === 'FORGE_SW_VERSION') finish(event.data.revision)
      }
      try {
        worker.postMessage({ type: 'FORGE_GET_VERSION' }, [channel.port2])
      } catch {
        finish(fallbackRevision(worker))
      }
    })
  }

  async considerWaitingWorker(worker) {
    if (!worker || !this.serviceWorker?.controller) return false
    this.waitingWorker = worker
    const safety = this.currentSafety()
    if (!safety.safe) {
      const revision = await this.workerRevision(worker)
      const actionRequired = safetyNeedsUserAction(safety.reason)
      this.emit(actionRequired ? 'update-ready' : 'update-deferred', {
        actionRequired,
        reason: safety.reason,
        revision,
      })
      return false
    }
    return this.activateWaitingWorker()
  }

  async activateWaitingWorker() {
    if (this.activationInFlight) return this.activationInFlight
    const worker = this.waitingWorker || this.registration?.waiting
    if (!worker) return false
    this.activationInFlight = (async () => {
      const safety = this.currentSafety()
      if (!safety.safe) {
        const revision = await this.workerRevision(worker)
        const actionRequired = safetyNeedsUserAction(safety.reason)
        this.emit(actionRequired ? 'update-ready' : 'update-deferred', {
          actionRequired,
          reason: safety.reason,
          revision,
        })
        return false
      }

      this.activationRevision = await this.workerRevision(worker)
      const finalSafety = this.currentSafety()
      if (!finalSafety.safe) {
        const actionRequired = safetyNeedsUserAction(finalSafety.reason)
        this.emit(actionRequired ? 'update-ready' : 'update-deferred', {
          actionRequired,
          reason: finalSafety.reason,
          revision: this.activationRevision,
        })
        return false
      }

      this.emit('activation-requested', { revision: this.activationRevision })
      worker.postMessage({ type: 'FORGE_ACTIVATE_UPDATE' })
      this.activationTimer = this.setTimeout?.(() => {
        this.emit('activation-timeout', {
          actionRequired: true,
          reason: 'activation-timeout',
          revision: this.activationRevision,
        })
      }, this.activationTimeoutMs)
      return true
    })().catch((error) => {
      this.logger?.warn?.('[service-worker/update] activation failed:', error?.message || error)
      this.emit('activation-failed', {
        actionRequired: true,
        reason: 'activation-failed',
        revision: this.activationRevision,
      })
      return false
    }).finally(() => {
      this.activationInFlight = null
    })
    return this.activationInFlight
  }

  handleControllerChange() {
    this.emit('controllerchange', { revision: this.activationRevision })
    if (!this.activationRevision || this.reloaded) return
    if (this.activationTimer) this.clearTimeout?.(this.activationTimer)
    this.activationTimer = null
    this.waitingWorker = null
    this.pendingReloadRevision = this.activationRevision
    this.reloadAfterActivation()
  }

  reloadAfterActivation() {
    if (!this.pendingReloadRevision || this.reloaded) return false
    const safety = this.currentSafety()
    if (!safety.safe) {
      const actionRequired = safetyNeedsUserAction(safety.reason)
      this.emit(actionRequired ? 'update-activated' : 'update-deferred', {
        actionRequired,
        reason: safety.reason,
        revision: this.pendingReloadRevision,
      })
      return false
    }
    try {
      if (storageValue(this.sessionStorage, RELOAD_MARKER_KEY) === this.pendingReloadRevision) {
        this.emit('update-adopted', { revision: this.pendingReloadRevision })
        this.pendingReloadRevision = null
        return false
      }
      this.sessionStorage.setItem(RELOAD_MARKER_KEY, this.pendingReloadRevision)
    } catch {
      this.emit('update-activated', {
        actionRequired: true,
        reason: 'reload-marker-unavailable',
        revision: this.pendingReloadRevision,
      })
      return false
    }
    this.reloaded = true
    this.emit('reloading', { revision: this.pendingReloadRevision })
    this.location?.reload?.()
    return true
  }

  retryPendingUpdate() {
    if (this.pendingReloadRevision) return this.reloadAfterActivation()
    if (this.waitingWorker || this.registration?.waiting) return this.activateWaitingWorker()
    return false
  }

  requestUpdate() {
    return this.retryPendingUpdate()
  }
}

let singleton = null

export function startServiceWorkerUpdates(options = {}) {
  if (singleton) return singleton
  singleton = new ServiceWorkerUpdateManager({
    window,
    document,
    serviceWorker: navigator.serviceWorker,
    localStorage,
    sessionStorage,
    location: window.location,
    ...options,
  })
  void singleton.start()
  return singleton
}

export function getServiceWorkerUpdateState() {
  return singleton?.getSnapshot() || { ...IDLE_SNAPSHOT }
}

export function requestServiceWorkerUpdate() {
  return singleton?.requestUpdate() || false
}
