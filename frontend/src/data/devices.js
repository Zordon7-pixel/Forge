// Extensible device registry for wearables and smart integrations
// Add new devices by appending to this array — UI renders whatever is here

export const DEVICES_REGISTRY = [
  {
    id: 'apple-watch',
    name: 'Apple Watch',
    type: 'smartwatch',
    status: 'coming_soon', // 'connected' | 'available' | 'coming_soon'
    icon: 'Watch',
    capabilities: ['heart-rate', 'gps', 'pace', 'cadence'],
  },
  {
    id: 'garmin',
    name: 'Garmin',
    type: 'smartwatch',
    status: 'available',
    icon: 'Watch',
    capabilities: ['heart-rate', 'gps', 'training-load', 'recovery-time'],
  },
  {
    id: 'oura',
    name: 'Oura',
    type: 'ring',
    status: 'available',
    icon: 'Heart',
    capabilities: ['readiness', 'sleep-tracking', 'hrv'],
  },
]

// Helper to get icon component name from lucide-react
export const ICON_MAP = {
  'Watch': 'Watch',
  'Glasses': 'Eye',
  'Zap': 'Zap',
  'Heart': 'Heart',
}
