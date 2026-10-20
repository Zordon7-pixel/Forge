import { useEffect, useState } from 'react'
import { MapContainer, TileLayer } from 'react-leaflet'
import api from '../../lib/api'

// Only the intentionally public tile key crosses the runtime API boundary.
// Host/style are fixed here, never supplied by users or runtime configuration.
export function tileUrl(config) {
  const key = config?.THUNDERFOREST_API_KEY
  return typeof key === 'string' && key.length === 32 && /^[A-Za-z0-9]{32}$/.test(key)
    ? `https://api.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey=${key}`
    : null
}

export default function ForgeMap({ children, style, ...mapProps }) {
  const [url, setUrl] = useState(null)
  const [failed, setFailed] = useState(false)
  const [resolved, setResolved] = useState(false)

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
    <div data-testid="forge-map" data-map-state={url && !failed ? 'ready' : resolved || failed ? 'unavailable' : 'loading'} style={{ ...style, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ flex: '1 1 0', minHeight: 0, position: 'relative' }}>
        {url ? (
          // Keep the map and all recorded/planned overlays mounted on tile failure.
          <MapContainer {...mapProps} zoomAnimation={false} attributionControl={false} style={{ height: '100%', width: '100%', background: '#16130D' }}>
            {!failed && <TileLayer url={url} maxZoom={22} eventHandlers={{ tileerror: () => setFailed(true) }} />}
            {children}
          </MapContainer>
        ) : (
          <div role="status" style={{ height: '100%', display: 'grid', placeItems: 'center', background: '#16130D', color: '#FFF6DC', padding: 12, textAlign: 'center' }}>
            Map unavailable.
          </div>
        )}
        {url && failed && <div role="status" style={{ position: 'absolute', top: 8, right: 8, maxWidth: 'calc(100% - 64px)', zIndex: 600, pointerEvents: 'none', background: '#16130D', color: '#FFF6DC', padding: '4px 8px', fontSize: 12, borderRadius: 4 }}>Map unavailable.</div>}
      </div>
      <div data-testid="map-attribution" style={{ flex: '0 0 auto', position: 'relative', zIndex: 600, padding: '4px 8px', background: '#FFFFFF', color: '#202020', fontSize: 12, lineHeight: '18px', textAlign: 'center', overflowWrap: 'anywhere' }}>
        Maps © <a href="https://www.thunderforest.com/" target="_blank" rel="noopener noreferrer" style={{ color: '#155078', textDecoration: 'underline' }}>Thunderforest</a>, Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" style={{ color: '#155078', textDecoration: 'underline' }}>OpenStreetMap contributors</a>
      </div>
    </div>
  )
}
