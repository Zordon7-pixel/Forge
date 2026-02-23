// Extensible device registry for wearables and smart integrations
// Add new devices by appending to this array — UI renders whatever is here

export const DEVICES_REGISTRY = [
  {
    id: 'apple-watch',
    name: 'Apple Watch',
    type: 'smartwatch',
    status: 'coming_soon', // 'connected' | 'available' | 'coming_soon'
    icon: 'Watch',
    capabilities: ['heart-rate', 'gps', 'pace', 'cadence', 'elevation'],
  },
  {
    id: 'meta-glasses',
    name: 'Meta Ray-Ban Glasses',
    type: 'ar-glasses',
    status: 'connected', // Assumes user has synced; fetch real status from /api/devices/meta-glasses
    icon: 'Glasses',
    capabilities: ['route-guidance', 'real-time-metrics', 'voice-control'],
  },
  {
    id: 'garmin',
    name: 'Garmin',
    type: 'smartwatch',
    status: 'coming_soon',
    icon: 'Watch',
    capabilities: ['heart-rate', 'gps', 'training-load', 'recovery-time'],
  },
  {
    id: 'whoop',
    name: 'Whoop',
    type: 'wearable',
    status: 'coming_soon',
    icon: 'Zap',
    capabilities: ['recovery', 'strain', 'sleep-tracking'],
  },
  {
    id: 'polar',
    name: 'Polar',
    type: 'smartwatch',
    status: 'coming_soon',
    icon: 'Heart',
    capabilities: ['heart-rate', 'training-zones', 'recovery'],
  },
]

// Helper to get icon component name from lucide-react
export const ICON_MAP = {
  'Watch': 'Watch',
  'Glasses': 'Eye',
  'Zap': 'Zap',
  'Heart': 'Heart',
}
