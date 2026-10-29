import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer } from 'react-leaflet'
import api from '../../lib/api'

// Only the intentionally public tile key crosses the runtime API boundary.
// Host and builder styles are fixed here; arbitrary URLs/styles are never accepted.
export const BUILDER_MAP_STYLES = Object.freeze({
  outdoors: 'Outdoors (trails)', landscape: 'Landscape (terrain)', 'mobile-atlas': 'Mobile Atlas (roads)',
})
export function tileUrl(config) {
  const key = config?.THUNDERFOREST_API_KEY
  return typeof key === 'string' && key.length === 32 && /^[A-Za-z0-9]{32}$/.test(key)
    ? `https://api.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey=${key}`
    : null
}

export default function ForgeMap({ children, style, builderMapStyle, ...mapProps }) {
  const [url, setUrl] = useState(null)
  const [failed, setFailed] = useState(false)
  const [resolved, setResolved] = useState(false)
  const [failedLayer, setFailedLayer] = useState(null)
  const selectedStyle = Object.hasOwn(BUILDER_MAP_STYLES, builderMapStyle) ? builderMapStyle : 'outdoors'
  const builder = builderMapStyle !== undefined
  const selectedUrl = builder && url ? url.replace('/outdoors/', `/${selectedStyle}/`) : url
  // Each selection has its own identity, including A -> B -> A. No reset effect
  // can race a fresh tileerror, and late events from removed layers are ignored.
  const layer = useMemo(() => ({ url: selectedUrl }), [selectedUrl])
  const currentLayer = useRef(layer)
  currentLayer.current = layer
  const tileFailed = builder ? failedLayer === layer : failed
  const unavailable = failed || tileFailed

  useEffect(() => {
    const controller = new AbortController()
    api.get('/meta/map-tiles', { signal: controller.signal, timeout: 8000 })
      .then(({ data }) => {
        if (!controller.signal.aborted) {
          setUrl(tileUrl(data))
          setResolved(true)
        }
      })
      .catch(() => {
        // Do not log Axios/provider errors: they may carry credentials/URLs.
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [])

  return (
    <div data-testid="forge-map" data-map-state={url && !unavailable ? 'ready' : resolved || failed ? 'unavailable' : 'loading'} style={{ ...style, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ flex: '1 1 0', minHeight: 0, position: 'relative' }}>
        {resolved || failed ? (
          // Resolved config failure and tile failure hide only the basemap.
          // Recorded/planned overlays do not depend on provider availability.
          <MapContainer {...mapProps} zoomAnimation={false} attributionControl={false} style={{ height: '100%', width: '100%', background: '#16130D' }}>
            {url && !unavailable && <TileLayer key={builder ? selectedStyle : 'default'} url={selectedUrl} maxZoom={22} eventHandlers={{ tileerror: () => {
              if (!builder) setFailed(true)
              else if (currentLayer.current === layer) setFailedLayer(layer)
            } }} />}
            {children}
          </MapContainer>
        ) : (
          <div role="status" style={{ height: '100%', display: 'grid', placeItems: 'center', background: '#16130D', color: '#FFF6DC', padding: 12, textAlign: 'center' }}>
            Map unavailable.
          </div>
        )}
        {(resolved || failed) && (!url || unavailable) && <div role="status" style={{ position: 'absolute', top: 8, right: 8, maxWidth: 'calc(100% - 64px)', zIndex: 600, pointerEvents: 'none', background: '#16130D', color: '#FFF6DC', padding: '4px 8px', fontSize: 12, borderRadius: 4 }}>Map unavailable.</div>}
      </div>
      <div data-testid="map-attribution" style={{ flex: '0 0 auto', position: 'relative', zIndex: 600, padding: '4px 8px', background: '#FFFFFF', color: '#202020', fontSize: 12, lineHeight: '18px', textAlign: 'center', overflowWrap: 'anywhere' }}>
        Maps © <a href="https://www.thunderforest.com/" target="_blank" rel="noopener noreferrer" style={{ color: '#155078', textDecoration: 'underline' }}>Thunderforest</a>, Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" style={{ color: '#155078', textDecoration: 'underline' }}>OpenStreetMap contributors</a>
      </div>
    </div>
  )
}
