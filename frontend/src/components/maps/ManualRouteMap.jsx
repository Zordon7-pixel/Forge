import { useEffect, useRef } from 'react'
import { CircleMarker, Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import ForgeMap from './ForgeMap'
import { DomEvent } from 'leaflet'

const latLng = point => [point[1], point[0]]
function EditorControls({ state, editor, fitVersion, disabled }) {
  const control = useRef(null)
  const map = useMap(), latest = useRef({ state, editor, disabled }), suppressedUntil = useRef(0)
  latest.current = { state, editor, disabled }
  useEffect(() => {
    const node = control.current
    DomEvent.disableClickPropagation(node)
    return () => DomEvent.off(node)
  }, [])
  useMapEvents({ click(event) {
    if (latest.current.disabled || Date.now() < suppressedUntil.current || !latest.current.state.waypoints.length) return
    latest.current.editor.add([event.latlng.lng, event.latlng.lat])
  } })
  useEffect(() => {
    const node = map.getContainer()
    node.setAttribute('aria-label', 'Planned route map. Use arrow keys to pan, then use the map center button. Long-press to set a start; tap to add a waypoint.')
    let timer, origin, pointer
    const cancel = () => { clearTimeout(timer); origin = null; pointer = null }
    const down = event => {
      // Leaflet's keyboard handler focuses on mousedown and restores page scroll.
      // Focus first without scrolling so a tap cannot move the map before pointerup.
      if (!event.target.closest('.leaflet-control')) node.focus({ preventScroll: true })
      if (latest.current.state.waypoints.length) suppressedUntil.current = 0
      if (pointer !== null && pointer !== undefined) { cancel(); return }
      if (latest.current.disabled || event.target.closest('.leaflet-control') || latest.current.state.waypoints.length || (event.pointerType === 'mouse' && event.button !== 0)) return
      pointer = event.pointerId; origin = [event.clientX, event.clientY]
      const point = map.mouseEventToLatLng(event)
      timer = setTimeout(() => {
        suppressedUntil.current = Date.now() + 900
        if (!latest.current.disabled) latest.current.editor.setStart([point.lng, point.lat]); cancel()
      }, 550)
    }
    const move = event => { if (origin && Math.hypot(event.clientX - origin[0], event.clientY - origin[1]) > 8) cancel() }
    const context = event => event.preventDefault()
    node.addEventListener('pointerdown', down, true); node.addEventListener('pointermove', move)
    node.addEventListener('pointerup', cancel); node.addEventListener('pointercancel', cancel)
    node.addEventListener('contextmenu', context)
    return () => {
      cancel(); node.removeEventListener('pointerdown', down, true); node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerup', cancel); node.removeEventListener('pointercancel', cancel)
      node.removeEventListener('contextmenu', context)
    }
  }, [map])
  const first = state.coordinates[0]
  useEffect(() => {
    if (first && state.coordinates.length === 1) map.setView(latLng(first), 15, { animate: false })
  }, [map, first, state.coordinates.length])
  useEffect(() => {
    if (state.coordinates.length > 1) map.fitBounds(state.coordinates.map(latLng), { paddingTopLeft: [64, 110], paddingBottomRight: [24, 70], animate: false })
    // Only explicit load/overview requests fit the whole route, not every tap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitVersion])
  return <div ref={control} className="manual-route-map-center leaflet-control" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <button type="button" onClick={event => {
      event.stopPropagation()
      const center = map.getCenter(), point = [center.lng, center.lat]
      if (state.waypoints.length) editor.add(point)
      else editor.setStart(point)
    }}>{state.waypoints.length ? 'Add map center waypoint' : 'Use map center as start'}</button>
  </div>
}
export default function ManualRouteMap({ state, editor, turnaround, fitVersion, disabled }) {
  return <ForgeMap center={[20, 0]} zoom={2} minZoom={2} worldCopyJump keyboard doubleClickZoom={false}
    style={{ height: 390 }}>
    <EditorControls state={state} editor={editor} fitVersion={fitVersion} disabled={disabled} />
    {state.legs.map((leg, index) => <Polyline key={`${index}-${leg.mode}-${leg.endIndex}`}
      positions={state.coordinates.slice(leg.startIndex, leg.endIndex + 1).map(latLng)}
      pathOptions={{ color: leg.mode === 'straight' ? '#F9D26B' : '#F97316', weight: 5, dashArray: leg.mode === 'straight' ? '8 8' : undefined }} />)}
    {state.waypoints.map((point, index) => <CircleMarker key={index} center={latLng(point)} radius={index ? 4 : 8}
      pathOptions={{ color: '#FFFFFF', fillColor: index ? '#F97316' : '#22C55E', fillOpacity: 1 }}>
      <Tooltip>{index ? `Planned waypoint ${index}` : 'Planned start'}</Tooltip>
    </CircleMarker>)}
    {state.pending && <CircleMarker center={latLng(state.pending)} radius={8} pathOptions={{ color: '#FFFFFF', dashArray: '3 3', fillOpacity: 0 }}><Tooltip>Unaccepted waypoint</Tooltip></CircleMarker>}
    {turnaround && <CircleMarker center={latLng(turnaround)} radius={10} pathOptions={{ color: '#FFFFFF', fillColor: '#A78BFA', fillOpacity: 1 }}>
      <Tooltip permanent direction="top">Target halfway</Tooltip>
    </CircleMarker>}
  </ForgeMap>
}
