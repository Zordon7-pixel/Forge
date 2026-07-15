const movement = ({ id, name, duration = 30, reps, muscle, cue, image, focuses }) => ({
  id,
  name,
  duration,
  durationLabel: reps,
  reps,
  type: 'mobility',
  muscle,
  cue,
  image_url: `/stretches/${image}`,
  focuses,
})

export const liftWarmupMovements = [
  movement({ id: 'lift-arm-swings', name: 'Arm Swings', reps: '20 controlled reps', muscle: 'chest & shoulders', cue: 'Open your arms wide, then sweep them across your chest without forcing the range.', image: 'arm-swings.png', focuses: ['chest', 'back', 'shoulders', 'arms', 'full'] }),
  movement({ id: 'lift-trunk-rotation', name: 'Trunk Rotation', reps: '10 each side', muscle: 'upper back & core', cue: 'Stand tall and rotate through your upper back while your hips stay facing forward.', image: 'trunk-rotation.webp', focuses: ['chest', 'back', 'shoulders', 'arms', 'core', 'full'] }),
  movement({ id: 'lift-inchworm', name: 'Inchworm', duration: 40, reps: '6 controlled reps', muscle: 'hamstrings, shoulders & core', cue: 'Hinge forward, walk your hands to a strong plank, then walk them back and stand.', image: 'inchworm.webp', focuses: ['chest', 'back', 'shoulders', 'arms', 'core', 'legs', 'full'] }),
  movement({ id: 'lift-worlds-greatest', name: "World's Greatest Stretch", duration: 40, reps: '5 each side', muscle: 'hips, hamstrings & upper back', cue: 'Step into a deep lunge, rotate toward the front leg, then switch sides.', image: 'worlds-greatest.webp', focuses: ['back', 'legs', 'core', 'full'] }),
  movement({ id: 'lift-walking-lunges', name: 'Walking Lunges', duration: 40, reps: '8 each leg', muscle: 'quads, glutes & hips', cue: 'Step into a controlled lunge and alternate legs while keeping your torso tall.', image: 'walking-lunges.png', focuses: ['legs', 'core', 'full'] }),
  movement({ id: 'lift-hip-circles', name: 'Hip Circles', reps: '10 each direction', muscle: 'hips & glutes', cue: 'Keep your feet planted and draw smooth circles with your hips in both directions.', image: 'hip-circles.png', focuses: ['legs', 'core', 'full'] }),
  movement({ id: 'lift-leg-swings', name: 'Leg Swings', reps: '10 each leg', muscle: 'hips & hamstrings', cue: 'Use a rack for balance and swing one leg forward and back through a controlled range.', image: 'leg-swings-male.png', focuses: ['legs', 'full'] }),
  movement({ id: 'lift-ankle-rolls', name: 'Ankle Rolls', reps: '10 each direction', muscle: 'ankles & calves', cue: 'Lift one foot and circle the ankle slowly in both directions before switching sides.', image: 'ankle-rolls.png', focuses: ['legs', 'full'] }),
  movement({ id: 'lift-cat-cow', name: 'Cat-Cow', duration: 40, reps: '8 slow cycles', muscle: 'spine & core', cue: 'Move slowly between a rounded and extended spine while breathing through each position.', image: 'cat-cow.webp', focuses: ['back', 'core', 'full'] }),
  movement({ id: 'lift-bridge-hold', name: 'Glute Bridge Hold', duration: 35, reps: '8 reps with a 2 sec hold', muscle: 'glutes & core', cue: 'Drive through your heels, squeeze your glutes at the top, and keep your ribs down.', image: 'bridge-hold.webp', focuses: ['legs', 'core', 'full'] }),
  movement({ id: 'lift-chest-opener-pulses', name: 'Chest Opener Pulses', reps: '12 controlled reps', muscle: 'chest & front shoulders', cue: 'Clasp your hands behind you and gently lift and lower them without arching your back.', image: 'chest-opener.webp', focuses: ['chest', 'shoulders', 'arms', 'full'] }),
  movement({ id: 'lift-cross-body-sweeps', name: 'Cross-Body Shoulder Sweeps', reps: '10 each arm', muscle: 'rear shoulders & upper back', cue: 'Guide one arm across your chest, release, and alternate sides with a smooth rhythm.', image: 'cross-body-shoulder.webp', focuses: ['chest', 'back', 'shoulders', 'arms', 'full'] }),
  movement({ id: 'lift-overhead-lat-reaches', name: 'Overhead Lat Reaches', reps: '8 each side', muscle: 'lats & shoulders', cue: 'Reach one arm overhead and lengthen through the side body without twisting your hips.', image: 'overhead-lat.webp', focuses: ['chest', 'back', 'shoulders', 'arms', 'full'] }),
  movement({ id: 'lift-wrist-pulses', name: 'Wrist Flexor Pulses', reps: '10 each wrist', muscle: 'wrists & forearms', cue: 'Keep your elbow straight and gently pulse the fingers down with the opposite hand.', image: 'wrist-flexor.webp', focuses: ['chest', 'back', 'shoulders', 'arms', 'full'] }),
  movement({ id: 'lift-pelvic-tilt', name: 'Pelvic Tilt', reps: '10 slow reps', muscle: 'deep core & lower back', cue: 'Exhale as you gently flatten your lower back, then return to neutral without forcing it.', image: 'pelvic-tilt.webp', focuses: ['core', 'legs', 'full'] }),
  movement({ id: 'lift-lateral-lunge', name: 'Lateral Lunge Shift', duration: 35, reps: '8 each side', muscle: 'adductors, glutes & quads', cue: 'Shift into one hip while the other leg stays long, then drive smoothly to the other side.', image: 'lateral-lunge-hold.webp', focuses: ['legs', 'full'] }),
]

export const liftRecoveryMovements = [
  movement({ id: 'lift-recovery-chest-opener', name: 'Chest Opener Stretch', duration: 40, reps: 'Hold 40 seconds', muscle: 'chest & front shoulders', cue: 'Clasp your hands behind you and lift only until you feel a gentle stretch across the chest.', image: 'chest-opener.webp', focuses: ['chest', 'shoulders', 'arms', 'full'] }),
  movement({ id: 'lift-recovery-doorway-chest', name: 'Doorway Chest Stretch', duration: 35, reps: 'Hold 30 sec each side', muscle: 'chest & shoulders', cue: 'Place one forearm on a rack or doorway and turn away slowly while keeping the shoulder down.', image: 'doorway-chest.webp', focuses: ['chest', 'shoulders', 'arms', 'full'] }),
  movement({ id: 'lift-recovery-cross-body', name: 'Cross-Body Shoulder Stretch', duration: 35, reps: 'Hold 30 sec each side', muscle: 'rear shoulders & upper back', cue: 'Draw one arm across your chest without lifting the shoulder toward your ear.', image: 'cross-body-shoulder.webp', focuses: ['chest', 'back', 'shoulders', 'arms', 'full'] }),
  movement({ id: 'lift-recovery-tricep', name: 'Overhead Tricep Stretch', duration: 35, reps: 'Hold 30 sec each side', muscle: 'triceps & shoulders', cue: 'Point one elbow up and guide it gently back while keeping your ribs stacked.', image: 'overhead-tricep.webp', focuses: ['chest', 'shoulders', 'arms', 'full'] }),
  movement({ id: 'lift-recovery-lat', name: 'Overhead Lat Stretch', duration: 35, reps: 'Hold 30 sec each side', muscle: 'lats & side body', cue: 'Reach one arm high, anchor your hips, and lengthen through the side without twisting.', image: 'overhead-lat.webp', focuses: ['chest', 'back', 'shoulders', 'arms', 'full'] }),
  movement({ id: 'lift-recovery-wrist', name: 'Wrist Flexor Stretch', duration: 30, reps: 'Hold 20 sec each side', muscle: 'wrists & forearms', cue: 'Keep the elbow straight and gently draw the fingers down until the forearm relaxes.', image: 'wrist-flexor.webp', focuses: ['chest', 'back', 'shoulders', 'arms', 'full'] }),
  movement({ id: 'lift-recovery-upper-trap', name: 'Upper Trap Stretch', duration: 35, reps: 'Hold 30 sec each side', muscle: 'neck & upper traps', cue: 'Keep one shoulder heavy while gently tilting your opposite ear away from it.', image: 'upper-trap.webp', focuses: ['chest', 'back', 'shoulders', 'arms', 'full'] }),
  movement({ id: 'lift-recovery-childs-pose', name: "Child's Pose", duration: 45, reps: 'Hold 45 seconds', muscle: 'lats, lower back & hips', cue: 'Sit your hips toward your heels, reach forward, and breathe into your back and sides.', image: 'childs-pose.png', focuses: ['back', 'shoulders', 'core', 'legs', 'full'] }),
  movement({ id: 'lift-recovery-cat-cow', name: 'Cat-Cow', duration: 40, reps: '8 slow cycles', muscle: 'spine & core', cue: 'Move gently between a rounded and extended spine without forcing either end range.', image: 'cat-cow.webp', focuses: ['back', 'core', 'full'] }),
  movement({ id: 'lift-recovery-cobra', name: 'Cobra Stretch', duration: 35, reps: 'Hold 25 sec, repeat once', muscle: 'abdominals & hip flexors', cue: 'Press up only as high as your lower back stays comfortable and keep your shoulders down.', image: 'cobra.webp', focuses: ['core', 'full'] }),
  movement({ id: 'lift-recovery-supine-twist', name: 'Supine Spinal Twist', duration: 35, reps: 'Hold 30 sec each side', muscle: 'lower back & outer hips', cue: 'Guide one bent knee across your body while keeping both shoulders relaxed.', image: 'supine-twist.webp', focuses: ['back', 'core', 'legs', 'full'] }),
  movement({ id: 'lift-recovery-knee-to-chest', name: 'Knee-to-Chest Stretch', duration: 35, reps: 'Hold 30 sec each side', muscle: 'glutes, hips & lower back', cue: 'Lie back and draw one knee toward your chest while the other leg stays relaxed.', image: 'knee-to-chest.webp', focuses: ['core', 'legs', 'full'] }),
  movement({ id: 'lift-recovery-pelvic-tilt', name: 'Pelvic Tilt', duration: 35, reps: '10 slow reps', muscle: 'deep core & lower back', cue: 'Exhale as you gently flatten your lower back, then return to a neutral spine.', image: 'pelvic-tilt.webp', focuses: ['core', 'legs', 'full'] }),
  movement({ id: 'lift-recovery-quad', name: 'Kneeling Quad Stretch', duration: 35, reps: 'Hold 30 sec each side', muscle: 'quads & hip flexors', cue: 'Tuck your pelvis and shift forward slightly while keeping the front knee stacked.', image: 'kneeling-quad.webp', focuses: ['legs', 'full'] }),
  movement({ id: 'lift-recovery-hamstring', name: 'Hamstring Stretch', duration: 35, reps: 'Hold 30 sec each side', muscle: 'hamstrings', cue: 'Extend one leg and hinge forward with a long spine until you feel a gentle stretch.', image: 'hamstring-stretch.png', focuses: ['legs', 'full'] }),
  movement({ id: 'lift-recovery-hip-flexor', name: 'Hip Flexor Stretch', duration: 35, reps: 'Hold 30 sec each side', muscle: 'hip flexors & quads', cue: 'Use a half-kneeling stance, tuck your pelvis, and shift forward without arching your back.', image: 'hip-flexor-male.png', focuses: ['legs', 'core', 'full'] }),
  movement({ id: 'lift-recovery-figure-four', name: 'Figure Four Stretch', duration: 35, reps: 'Hold 30 sec each side', muscle: 'glutes & outer hips', cue: 'Cross one ankle over the opposite knee and sit back until the glute relaxes.', image: 'figure-four.png', focuses: ['legs', 'full'] }),
  movement({ id: 'lift-recovery-butterfly', name: 'Butterfly Stretch', duration: 40, reps: 'Hold 40 seconds', muscle: 'inner thighs & hips', cue: 'Bring the soles of your feet together, sit tall, and let your knees lower comfortably.', image: 'butterfly.webp', focuses: ['legs', 'full'] }),
]

function planText(plan = {}) {
  const exercises = Array.isArray(plan?.main)
    ? plan.main.map((exercise) => [exercise?.name, exercise?.exercise, exercise?.muscle_group, exercise?.focus].filter(Boolean).join(' '))
    : []
  return [plan?.workoutName, plan?.title, plan?.target, plan?.focus, ...exercises]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

export function inferLiftFocus(plan = {}) {
  const text = planText(plan)
  const armText = text.replace(/single[- ]arm|one[- ]arm/g, '')
  if (/full body|total body|hybrid/.test(text)) return 'full'

  const scores = {
    chest: (text.match(/chest|bench|push-up|push up|pec|chest fly/g) || []).length,
    back: (text.match(/\bback\b|row|pull-up|pull up|pulldown|lat\b/g) || []).length,
    legs: (text.match(/lower body|\bleg|squat|deadlift|lunge|glute|quad|hamstring|calf/g) || []).length,
    shoulders: (text.match(/shoulder|overhead press|arnold press|lateral raise/g) || []).length,
    arms: (armText.match(/\barms?\b|bicep|tricep|curl|skull crusher/g) || []).length,
    core: (text.match(/\bcore\b|\bab\b|plank|crunch|carry/g) || []).length,
  }
  const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1])
  if (!ranked[0][1]) return 'full'
  if (ranked[1] && ranked[1][1] === ranked[0][1]) return 'full'
  return ranked[0][0]
}

export function getLiftMobilityPool(plan = {}, phase = 'warmup') {
  const focus = inferLiftFocus(plan)
  const catalog = phase === 'recovery' ? liftRecoveryMovements : liftWarmupMovements
  const focused = catalog.filter((item) => item.focuses.includes(focus))
  if (focused.length >= 6) return focused

  const fallback = catalog.filter((item) => item.focuses.includes('full'))
  const seen = new Set(focused.map((item) => item.id))
  return [...focused, ...fallback.filter((item) => !seen.has(item.id))]
}
