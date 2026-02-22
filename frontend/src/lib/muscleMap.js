// Primary and secondary muscles per muscle group
export const MUSCLE_RELATIONSHIPS = {
  chest: {
    primary: ['chest'],
    secondary: ['triceps', 'front shoulders'],
    label: 'Chest'
  },
  back: {
    primary: ['back'],
    secondary: ['biceps', 'rear shoulders', 'core'],
    label: 'Back'
  },
  legs: {
    primary: ['quads', 'hamstrings', 'glutes'],
    secondary: ['calves', 'core', 'hip flexors'],
    label: 'Legs'
  },
  shoulders: {
    primary: ['shoulders'],
    secondary: ['triceps', 'upper traps'],
    label: 'Shoulders'
  },
  arms: {
    primary: ['biceps', 'triceps'],
    secondary: ['forearms', 'shoulders'],
    label: 'Arms'
  },
  core: {
    primary: ['abs', 'obliques'],
    secondary: ['hip flexors', 'lower back'],
    label: 'Core'
  }
}

// Map muscle group name to diagram zone keys
export const GROUP_TO_ZONES = {
  chest: ['chest'],
  back: ['back'],
  legs: ['legs'],
  shoulders: ['shoulders'],
  arms: ['arms'],
  core: ['core']
}

export function getMuscleBreakdown(muscleGroups = []) {
  const primary = new Set()
  const secondary = new Set()

  muscleGroups.forEach(group => {
    const rel = MUSCLE_RELATIONSHIPS[group]
    if (!rel) return
    rel.primary.forEach(m => primary.add(m))
    rel.secondary.forEach(m => secondary.add(m))
  })

  // Remove from secondary any that are already primary
  primary.forEach(m => secondary.delete(m))

  return {
    primary: [...primary],
    secondary: [...secondary]
  }
}
