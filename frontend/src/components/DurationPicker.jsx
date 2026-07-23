import { ChevronDown, X } from 'lucide-react'
import { durationPartsToSeconds, splitDurationSeconds } from '../lib/duration'

const MINUTE_SECOND_OPTIONS = Array.from({ length: 60 }, (_, value) => value)
const DEFAULT_MAX_HOURS = 99

function unitStyle() {
  return {
    display: 'grid',
    gap: 5,
    minWidth: 0,
  }
}

function selectStyle() {
  return {
    width: '100%',
    minWidth: 0,
    minHeight: 52,
    appearance: 'none',
    WebkitAppearance: 'none',
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 8,
    padding: '10px 32px 10px 12px',
    fontSize: 20,
    fontWeight: 900,
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'center',
  }
}

export default function DurationPicker({
  value = 0,
  onChange,
  disabled = false,
  idPrefix = 'duration',
  maxHours = DEFAULT_MAX_HOURS,
  ariaLabel = 'Goal time',
}) {
  const parts = splitDurationSeconds(value)
  const highestHour = Math.max(maxHours, parts.hours)
  const hourOptions = Array.from({ length: highestHour + 1 }, (_, option) => option)

  const changePart = (part) => (event) => {
    onChange?.(durationPartsToSeconds({ ...parts, [part]: Number(event.target.value) }))
  }

  const units = [
    { key: 'hours', label: 'Hours', options: hourOptions },
    { key: 'minutes', label: 'Minutes', options: MINUTE_SECOND_OPTIONS },
    { key: 'seconds', label: 'Seconds', options: MINUTE_SECOND_OPTIONS },
  ]

  return (
    <fieldset aria-label={ariaLabel} disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        {units.map((unit) => (
          <label key={unit.key} htmlFor={`${idPrefix}-${unit.key}`} style={unitStyle()}>
            <span style={{ color: 'var(--text-muted)', fontSize: 10, fontWeight: 900, textAlign: 'center', textTransform: 'uppercase' }}>
              {unit.label}
            </span>
            <span style={{ position: 'relative', display: 'block', minWidth: 0 }}>
              <select
                id={`${idPrefix}-${unit.key}`}
                aria-label={`${ariaLabel} ${unit.label.toLowerCase()}`}
                value={parts[unit.key]}
                onChange={changePart(unit.key)}
                style={selectStyle()}
              >
                {unit.options.map((option) => (
                  <option key={option} value={option}>
                    {String(option).padStart(2, '0')}
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden="true" size={16} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--accent)', pointerEvents: 'none' }} />
            </span>
          </label>
        ))}
      </div>
      {Number(value) > 0 && (
        <button
          type="button"
          onClick={() => onChange?.(0)}
          disabled={disabled}
          aria-label={`Clear ${ariaLabel.toLowerCase()}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 36, marginTop: 6, padding: '4px 8px', border: 0, background: 'transparent', color: 'var(--text-muted)', fontSize: 11, fontWeight: 800 }}
        >
          <X size={14} aria-hidden="true" /> Clear goal time
        </button>
      )}
    </fieldset>
  )
}
