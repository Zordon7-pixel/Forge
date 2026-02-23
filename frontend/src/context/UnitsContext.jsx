import { createContext, useContext, useState, useEffect } from 'react'
import api from '../lib/api'

const UnitsContext = createContext()

// Conversion constants
const KM_PER_MILE = 1.60934
const KG_PER_LB = 0.453592
const FT_PER_METER = 3.28084

export function useUnits() {
  const ctx = useContext(UnitsContext)
  if (!ctx) throw new Error('useUnits must be used within UnitsProvider')
  return ctx
}

export function UnitsProvider({ children }) {
  const [units, setUnitsState] = useState('imperial')
  const [loading, setLoading] = useState(true)

  // Load units from API on mount
  useEffect(() => {
    api.get('/users/settings')
      .then(r => {
        setUnitsState(r.data.units || 'imperial')
      })
      .catch(() => setUnitsState('imperial'))
      .finally(() => setLoading(false))
  }, [])

  // Helper to update units both locally and via API
  const setUnits = async (newUnits) => {
    setUnitsState(newUnits)
    try {
      await api.put('/users/settings', { units: newUnits })
    } catch (err) {
      console.error('Failed to save units preference:', err)
      // Revert on failure
      setUnitsState(units)
    }
  }

  // Formatting utilities
  const fmt = {
    // Distance: miles input, returns formatted string or value
    distance: (miles, decimals = 2) => {
      if (!miles && miles !== 0) return '—'
      if (units === 'metric') {
        const km = miles * KM_PER_MILE
        return `${km.toFixed(decimals)} km`
      }
      return `${miles.toFixed(decimals)} mi`
    },

    distanceLabel: units === 'metric' ? 'km' : 'mi',

    // Raw distance value conversion
    distanceValue: (miles) => {
      if (units === 'metric') {
        return miles * KM_PER_MILE
      }
      return miles
    },

    // Pace: secondsPerMile input, returns formatted string
    pace: (secondsPerMile) => {
      if (!secondsPerMile) return '—'
      
      let displaySeconds = secondsPerMile
      if (units === 'metric') {
        // Convert pace from /mile to /km
        displaySeconds = secondsPerMile / KM_PER_MILE
      }

      const m = Math.floor(displaySeconds / 60)
      const s = Math.round(displaySeconds % 60)
      const label = units === 'metric' ? '/km' : '/mi'
      return `${m}:${String(s).padStart(2, '0')} ${label}`
    },

    paceLabel: units === 'metric' ? '/km' : '/mi',

    // Weight: lbs input, returns formatted string
    weight: (lbs, decimals = 1) => {
      if (!lbs && lbs !== 0) return '—'
      if (units === 'metric') {
        const kg = lbs * KG_PER_LB
        return `${kg.toFixed(decimals)} kg`
      }
      return `${lbs.toFixed(decimals)} lbs`
    },

    weightLabel: units === 'metric' ? 'kg' : 'lbs',

    // Weight value conversion (lbs to kg or vice versa)
    weightValue: (lbs) => {
      if (units === 'metric') {
        return lbs * KG_PER_LB
      }
      return lbs
    },

    // Temperature: celsius input, returns formatted string
    temp: (celsius) => {
      if (!celsius && celsius !== 0) return '—'
      if (units === 'metric') {
        return `${celsius.toFixed(0)}°C`
      }
      const fahrenheit = (celsius * 9/5) + 32
      return `${fahrenheit.toFixed(0)}°F`
    },

    // Elevation: meters input, returns formatted string
    elevation: (meters) => {
      if (!meters && meters !== 0) return '—'
      if (units === 'metric') {
        return `${meters.toFixed(0)} m`
      }
      const feet = meters * FT_PER_METER
      return `${feet.toFixed(0)} ft`
    },

    // Speed: mph input, returns formatted string
    speed: (mph) => {
      if (!mph && mph !== 0) return '—'
      if (units === 'metric') {
        const kmh = mph * KM_PER_MILE
        return `${kmh.toFixed(1)} km/h`
      }
      return `${mph.toFixed(1)} mph`
    },

    speedLabel: units === 'metric' ? 'km/h' : 'mph',

    // Conversion helpers for input → imperial (for backend storage)
    metersToFeet: (meters) => meters * FT_PER_METER,
    milesFromKm: (km) => km / KM_PER_MILE,
    lbsFromKg: (kg) => kg / KG_PER_LB,
  }

  return (
    <UnitsContext.Provider value={{ units, setUnits, fmt, loading }}>
      {children}
    </UnitsContext.Provider>
  )
}
