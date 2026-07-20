const RECOVERING_STATUSES = new Set(['recovering', 'chronic'])

function enabledFlag(value) {
  return value === true || value === 1 || value === '1'
}

export function finiteReadinessScore(value) {
  return Number.isFinite(value) ? Math.round(value) : null
}

export function resolveReadiness(readiness) {
  const score = readiness?.available === true
    ? finiteReadinessScore(readiness.score)
    : null

  return {
    available: score !== null,
    score,
    display: score === null ? '--' : String(score),
    sentencePrefix: score === null ? '' : `Readiness ${score}. `,
  }
}

export function resolveRecoveryState(profile = {}) {
  const injuryStatus = String(profile.injury_status || '').trim().toLowerCase()
  const activeInjuryMode = enabledFlag(profile.injury_mode)
  const comebackMode = enabledFlag(profile.comeback_mode) || RECOVERING_STATUSES.has(injuryStatus)

  if (activeInjuryMode) {
    return {
      kind: 'active',
      activeInjuryMode,
      comebackMode,
      protected: true,
      label: 'Active injury protection',
      description: 'Active injury mode adjusts training around current limitations.',
    }
  }

  if (comebackMode) {
    return {
      kind: 'comeback',
      activeInjuryMode,
      comebackMode,
      protected: true,
      label: 'Comeback protection enabled',
      description: 'Comeback mode is guiding a conservative return. Active injury mode is off.',
    }
  }

  return {
    kind: 'off',
    activeInjuryMode,
    comebackMode,
    protected: false,
    label: 'Off',
    description: 'No active injury or comeback protection is enabled.',
  }
}
