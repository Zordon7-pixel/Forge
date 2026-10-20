import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { ArrowLeft, MapPin, Route, Undo2 } from 'lucide-react'
import api from '../lib/api'
import { getAuthSession, isAuthSessionCurrent, subscribeAuthSession } from '../lib/tokenStore'
import { createLegClient, createRouteEditor, elevationStats, METERS_PER_MILE, MODE_LABELS,
  routePayload, turnaroundPoint, validPoint, validRouteId, validateSavedRoute } from '../lib/manualRouteBuilder'
import ManualRouteMap from '../components/maps/ManualRouteMap'
import './manualRoutes.css'

function summaries(data) {
  if (!Array.isArray(data?.routes) || data.routes.length > 20) throw new Error('Invalid library')
  return data.routes.map(route => {
    if (!validRouteId(route.id) || route.kind !== 'planned' || route.schemaVersion !== 1 || route.provenanceTrust !== 'client_declared' || typeof route.name !== 'string' || !route.name.trim()
      || route.name.length > 120 || typeof route.distanceMeters !== 'number' || !Number.isFinite(route.distanceMeters)
      || route.distanceMeters < 0 || route.distanceMeters > 1000000) throw new Error('Invalid library')
    return route
  })
}
export default function ManualRoutes() {
  const [session] = useState(getAuthSession)
  const [expired, setExpired] = useState(false)
  const [state, setState] = useState(null)
  const [editor, setEditor] = useState(null)
  const [name, setName] = useState('My planned route'), [target, setTarget] = useState('')
  const [savedId, setSavedId] = useState(null), [routes, setRoutes] = useState([]), [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(''), [notice, setNotice] = useState(''), [error, setError] = useState('')
  const [locating, setLocating] = useState(false), [locationError, setLocationError] = useState('')
  const [fitVersion, setFitVersion] = useState(0), [deleteId, setDeleteId] = useState(null)
  const [clock, setClock] = useState(Date.now())
  const active = useRef(false), controller = useRef(null), operation = useRef(false)
  const current = () => active.current && isAuthSessionCurrent(session)
  const config = () => ({ forgeAuthSession: session, signal: controller.current.signal })
  useEffect(() => {
    active.current = true; controller.current = new AbortController()
    const client = createLegClient(async body => {
      const { data } = await api.post('/route-planning/leg', body, { ...config(), timeout: 10000 })
      if (!current()) throw new Error('Account changed. Reopen your route library.')
      return data?.leg
    })
    const model = createRouteEditor({ client, onChange: value => { if (current()) setState(value) } })
    setEditor(model); setState(model.snapshot())
    const unsubscribe = subscribeAuthSession(() => {
      if (!isAuthSessionCurrent(session)) {
        model.dispose(); controller.current.abort(); setState(null); setRoutes([]); setExpired(true)
      }
    })
    void refresh(0)
    return () => { active.current = false; model.dispose(); controller.current.abort(); unsubscribe() }
    // The session owns every request/cache and the entire editor lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])
  useEffect(() => {
    if (!state?.error?.retryAt) return undefined
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [state?.error?.retryAt])
  async function perform(label, work) {
    if (operation.current || !current()) return
    operation.current = true; setBusy(label); setError(''); setNotice('')
    try { await work() }
    catch { if (current()) setError(`${label} failed. Your accepted draft is still here. Try again.`) }
    finally { operation.current = false; if (current()) setBusy('') }
  }
  async function readLibrary(page) {
    const { data } = await api.get('/user-routes', { ...config(), params: { limit: 20, offset: page } })
    const list = summaries(data)
    if (current()) { setRoutes(list); setOffset(page) }
  }
  async function refresh(page) { await perform('Load library', () => readLibrary(page)) }
  function locate() {
    if (locating || state.waypoints.length) return
    setLocating(true); setLocationError('')
    const token = editor.version()
    const failure = message => { if (current()) { setLocating(false); if (token === editor.version()) setLocationError(message) } }
    if (!navigator.geolocation) { failure('Location is unavailable. Long-press the map to choose your start.'); return }
    try {
      navigator.geolocation.getCurrentPosition(position => {
        if (!current()) return
        setLocating(false)
        if (token !== editor.version()) return
        const point = [position.coords.longitude, position.coords.latitude]
        if (!validPoint(point, false)) { failure('Location was invalid. Long-press the map to choose your start.'); return }
        editor.setStart(point)
      }, () => failure('Could not get your location. Check location permission or long-press the map to choose your start.'),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 })
    } catch { failure('Location is unavailable. Long-press the map to choose your start.') }
  }
  if (expired) return <section className="manual-routes"><h1>Account changed</h1><p>Your private route draft was cleared.</p><Link to="/run">Return to Train</Link></section>
  if (!state || !editor) return <p role="status">Opening private routes…</p>
  const targetMeters = target.trim() === '' ? null : Number(target) * METERS_PER_MILE
  const targetValid = targetMeters === null || (Number.isFinite(targetMeters) && targetMeters > 0 && targetMeters <= 1000000)
  const elevation = elevationStats(state.coordinates), turnaround = targetValid ? turnaroundPoint(state.coordinates, targetMeters) : null
  const retrySeconds = Math.max(0, Math.ceil(((state.error?.retryAt || 0) - clock) / 1000))
  const straightCount = state.legs.filter(leg => leg.mode === 'straight').length
  const clear = () => { editor.clear(); setSavedId(null); setName('My planned route'); setLocationError(''); setNotice(''); setError('') }
  async function save(copy) {
    if (!targetValid) return
    await perform(copy ? 'Save route' : 'Update route', async () => {
      const payload = routePayload(state, name, targetMeters)
      const { data } = savedId && !copy
        ? await api.put(`/user-routes/${savedId}`, payload, config())
        : await api.post('/user-routes', payload, config())
      if (!current()) return
      // Validate receipt without replacing the in-memory undo history/distances.
      const saved = validateSavedRoute(data?.route)
      setSavedId(saved.id); setNotice('Saved privately as a planned route.')
      try { await readLibrary(0) } catch { if (current()) setError('Route saved, but the library refresh failed. Refresh the library to verify it.') }
    })
  }
  return <div className="manual-routes">
    <Link className="manual-route-back" to="/run"><ArrowLeft size={18} aria-hidden="true" /> Train</Link>
    <header><p className="manual-route-eyebrow">YOUR NEXT COURSE</p><h1>Build your route</h1><p>Plan it your way. Private planned routes, not recorded runs or navigation.</p></header>
    <section aria-label="Route editor" className="manual-route-card">
      <fieldset disabled={!!busy}>
        <label htmlFor="route-name">Route name</label>
        <input id="route-name" maxLength={120} value={name} onChange={event => setName(event.target.value)} />
        <div className="manual-route-fields">
          <div><label htmlFor="route-mode">New leg mode</label><select id="route-mode" value={state.mode} onChange={event => editor.setMode(event.target.value)}>
            <option value="routed">Planned ORS route</option><option value="straight">Planned straight line</option>
          </select></div>
          <div><label htmlFor="route-profile">Routing profile</label><select id="route-profile" value={state.profile} disabled={state.mode === 'straight'} onChange={event => editor.setProfile(event.target.value)}>
            <option value="foot-walking">Walking</option><option value="foot-hiking">Hiking</option>
          </select></div>
        </div>
        <p className="manual-route-mode" role="status">{MODE_LABELS[state.mode]}{state.mode === 'straight' ? ' · Direct segments; paths and access are not checked.' : ' · Only the next leg is routed.'}</p>
        <button type="button" onClick={locate} disabled={locating || !!state.waypoints.length}><MapPin size={18} aria-hidden="true" />{locating ? 'Finding location…' : 'Start at current location'}</button>
        {locationError && <p role="alert">{locationError}</p>}
        <p id="route-map-help">{state.waypoints.length ? 'Tap the map to add a waypoint. A new tap replaces an unaccepted waypoint.' : 'Or long-press the map to set a start. The world view is not your location.'} Keyboard: pan with arrow keys, then use the map center button.</p>
        <div className="manual-route-map" aria-describedby="route-map-help" style={busy ? { pointerEvents: 'none' } : undefined}>
          <ManualRouteMap state={state} editor={editor} turnaround={turnaround} fitVersion={fitVersion} disabled={!!busy} />
        </div>
        <div className="manual-route-actions">
          <button type="button" onClick={() => editor.undo()} disabled={!state.canUndo}><Undo2 size={16} aria-hidden="true" />Undo</button>
          <button type="button" onClick={clear} disabled={!state.waypoints.length}>Clear</button>
          <button type="button" onClick={() => editor.closeLoop()} disabled={!state.legs.length}>Close loop</button>
          <button type="button" onClick={() => editor.outAndBack()} disabled={!state.legs.length}>Out-and-back</button>
          <button type="button" onClick={() => setFitVersion(value => value + 1)} disabled={!state.legs.length}>View whole route</button>
        </div>
        <p className="manual-route-help">Out-and-back mirrors accepted legs; it does not check return-direction access. Mode and profile changes apply to new legs.</p>
        {state.baseLegCount > 0 && <p className="manual-route-help">Loaded route is the saved base. Undo removes edits made since loading; Clear starts a new route. Saved data has no individual routed-leg distances.</p>}
        <div aria-live="polite" aria-atomic="true">
          {state.pending && !state.error && <p role="status">Routing the new leg… Accepted distance is unchanged.</p>}
          {state.error && <div role="alert"><p>{state.error.message}</p>{state.pending && <button type="button" disabled={retrySeconds > 0} onClick={() => editor.retry()}>{retrySeconds ? `Retry in ${retrySeconds}s` : 'Retry this leg'}</button>}</div>}
        </div>
        <div className="manual-route-metrics" aria-live="polite">
          <div><span>PLANNED DISTANCE</span><strong>{(state.distanceMeters / METERS_PER_MILE).toFixed(2)} <small>mi</small></strong></div>
          <div><span>ELEVATION</span><strong className="manual-route-elevation">{elevation.gainMeters === null ? 'Unavailable' : `+${Math.round(elevation.gainMeters * 3.28084)} / −${Math.round(elevation.lossMeters * 3.28084)} ft`}</strong><span>{elevation.coverage === 'partial' ? 'Partial heights · known adjacent points only' : elevation.coverage === 'complete' ? 'Calculated from supplied heights' : 'No usable adjacent heights'}</span></div>
        </div>
        <p>{state.legs.length} accepted legs{straightCount > 0 ? ` · ${straightCount} planned straight-line legs (dashed)` : ''}</p>
        <label htmlFor="route-target">Target distance (miles, optional)</label>
        <input id="route-target" type="number" inputMode="decimal" min="0.01" max="621.371" step="any" placeholder="26.2" value={target} aria-invalid={!targetValid} onChange={event => setTarget(event.target.value)} />
        {!targetValid && <p role="alert">Enter a positive target up to 621.371 miles.</p>}
        {targetValid && targetMeters !== null && <p role="status">{(Math.abs(state.distanceMeters - targetMeters) / METERS_PER_MILE).toFixed(2)} mi {state.distanceMeters >= targetMeters ? 'over' : 'under'} target. {turnaround ? 'Purple marker: target halfway along planned geometry.' : 'The planned geometry has not reached target halfway.'}</p>}
        <div className="manual-route-actions">
          <button className="manual-route-primary" type="button" disabled={!state.legs.length || !!state.pending || !name.trim() || !targetValid} onClick={() => save(!savedId)}><Route size={18} aria-hidden="true" />{savedId ? 'Update private route' : 'Save private route'}</button>
          {savedId && <button type="button" disabled={!!state.pending || !state.legs.length || !name.trim() || !targetValid} onClick={() => save(true)}>Save as new</button>}
        </div>
      </fieldset>
    </section>
    {busy && <p role="status">{busy}…</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    <section className="manual-route-card" aria-labelledby="route-library-title">
      <div className="manual-route-library-heading"><h2 id="route-library-title">Your route library</h2><button disabled={!!busy} onClick={() => refresh(offset)}>Refresh</button></div>
      <p>Planned · Private · Only you can access these routes.</p>
      {!routes.length && !busy && <p>No routes on this page. Build a course above to save it here.</p>}
      <ul className="manual-route-library">{routes.map(route => <li key={route.id}>
        <h3>{route.name}</h3><p>{(route.distanceMeters / METERS_PER_MILE).toFixed(2)} mi · Planned · Private</p>
        <div className="manual-route-actions">
          <button disabled={!!busy} onClick={() => perform('Load route', async () => {
            const { data } = await api.get(`/user-routes/${route.id}`, config())
            if (!current()) return
            const loaded = editor.load(data?.route)
            setSavedId(loaded.id); setName(loaded.name); setTarget(loaded.targetDistanceMeters === null ? '' : String(loaded.targetDistanceMeters / METERS_PER_MILE)); setLocationError(''); setFitVersion(value => value + 1); setNotice('Loaded saved base. Loading replaces the current draft.')
          })}>Load / edit</button>
          <button disabled={!!busy} onClick={() => perform('Download GPX', async () => {
            const { data } = await api.get(`/user-routes/${route.id}/gpx`, { ...config(), responseType: 'blob' })
            if (!current()) return
            const url = URL.createObjectURL(data), anchor = document.createElement('a')
            anchor.href = url; anchor.download = `planned-route-${route.id}.gpx`; document.body.appendChild(anchor); anchor.click(); anchor.remove()
            setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('Downloaded the saved planned route. Unsaved edits are not included.')
          })}>GPX</button>
          <button disabled={!!busy} onClick={() => setDeleteId(route.id)}>Delete</button>
        </div>
        {deleteId === route.id && <div role="group" aria-label={`Delete ${route.name}`}><p>Delete this private saved route?</p><div className="manual-route-actions">
          <button disabled={!!busy} onClick={() => perform('Delete route', async () => {
            await api.delete(`/user-routes/${route.id}`, config())
            if (!current()) return
            setRoutes(list => list.filter(item => item.id !== route.id)); setDeleteId(null)
            if (savedId === route.id) setSavedId(null)
            setNotice('Deleted saved route. Your open draft is unchanged.')
          })}>Confirm delete</button><button disabled={!!busy} onClick={() => setDeleteId(null)}>Cancel</button>
        </div></div>}
      </li>)}</ul>
      <p className="manual-route-help">Loading a route replaces the open draft. Save changes first.</p>
      <div className="manual-route-actions"><button disabled={!!busy || offset === 0} onClick={() => refresh(Math.max(0, offset - 20))}>Previous</button><button disabled={!!busy || routes.length < 20 || offset >= 1000000} onClick={() => refresh(offset + 20)}>Next</button></div>
    </section>
  </div>
}
