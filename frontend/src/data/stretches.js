const LOCAL_ASSETS = {
  'leg-swings': '/stretches/leg-swings-male.png',
  'hip-circles': '/stretches/hip-circles.png',
  'high-knees': '/stretches/high-knees.png',
  'butt-kicks': '/stretches/butt-kicks.png',
  'ankle-rolls': '/stretches/ankle-rolls.png',
  'walking-lunges': '/stretches/walking-lunges.png',
  'arm-swings': '/stretches/arm-swings.png',
  'standing-quad': '/stretches/standing-quad.png',
  'hamstring-stretch': '/stretches/hamstring-stretch.png',
  'calf-stretch': '/stretches/calf-stretch.png',
  'hip-flexor': '/stretches/hip-flexor-male.png',
  'figure-four': '/stretches/figure-four.png',
  'childs-pose': '/stretches/childs-pose.png',
}

function withSideMetadata(item) {
  const sideText = `${item.durationLabel || ''} ${item.reps || ''}`
  const sideMode = item.sideMode || (item.type === 'static' && sideText.includes('each side')
    ? 'each-side'
    : (/each (?:side|leg)|alternate sides/i.test(sideText) ? 'alternating' : 'bilateral'))
  return Object.freeze({
    ...item,
    sideMode,
    sides: sideMode === 'each-side' ? 2 : 1,
    image_url: item.image_url || LOCAL_ASSETS[item.id],
  })
}

export const preRunStretches = [
  { id: 'leg-swings', name: 'Leg Swings', duration: 30, durationLabel: '30 sec · 10 each side', reps: '10 each side', type: 'dynamic', muscle: 'hips & hip flexors', cue: 'Stand beside a wall and swing one leg forward and back in a controlled arc.' },
  { id: 'hip-circles', name: 'Hip Circles', duration: 30, durationLabel: '30 sec · 10 each direction', reps: '10 each direction', type: 'dynamic', muscle: 'hip flexors & glutes', cue: 'Keep your feet planted and draw controlled circles with your hips.' },
  { id: 'high-knees', name: 'High Knees', duration: 30, durationLabel: '30 sec', reps: '30 seconds', type: 'dynamic', muscle: 'hip flexors & quads', cue: 'Run in place, driving your knees toward waist height while pumping your arms.' },
  { id: 'butt-kicks', name: 'Butt Kicks', duration: 30, durationLabel: '30 sec', reps: '30 seconds', type: 'dynamic', muscle: 'hamstrings & quads', cue: 'Run lightly in place and bring each heel toward the same-side glute.' },
  { id: 'ankle-rolls', name: 'Ankle Rolls', duration: 30, durationLabel: '30 sec · 10 each direction', reps: '10 each direction', type: 'dynamic', muscle: 'ankles & calves', cue: 'Lift one foot and rotate the ankle through a comfortable full circle, then switch.' },
  { id: 'walking-lunges', name: 'Walking Lunges', duration: 40, durationLabel: '40 sec · 10 each leg', reps: '10 each leg', type: 'dynamic', muscle: 'quads, hip flexors & glutes', cue: 'Step into a controlled lunge and alternate legs while keeping your torso tall.' },
  { id: 'arm-swings', name: 'Arm Swings', duration: 30, durationLabel: '30 sec · 20 reps', reps: '20 reps', type: 'dynamic', muscle: 'chest & shoulders', cue: 'Swing both arms across your chest, then open them wide without forcing the range.' },
  { id: 'inchworm', name: 'Inchworm', duration: 40, durationLabel: '40 sec · 6 reps', reps: '6 reps', type: 'dynamic', muscle: 'hamstrings, shoulders & core', cue: 'Hinge forward, walk your hands to a strong plank, then walk them back and stand.', image_url: '/stretches/inchworm.webp' },
  { id: 'worlds-greatest', name: "World's Greatest Stretch", duration: 40, durationLabel: '40 sec · alternate sides', reps: '5 each side', type: 'dynamic', muscle: 'hips, hamstrings & upper back', cue: 'Step into a deep lunge, reach the inside arm toward the ceiling, then alternate sides.', image_url: '/stretches/worlds-greatest.webp' },
  { id: 'trunk-rotation', name: 'Trunk Rotation', duration: 30, durationLabel: '30 sec · 10 each side', reps: '10 each side', type: 'dynamic', muscle: 'upper back & core', cue: 'Stand tall and rotate through your upper back with your hips facing forward.', image_url: '/stretches/trunk-rotation.webp' },
  { id: 'marching-knee-hugs', name: 'Marching Knee Hugs', duration: 30, durationLabel: '30 sec · alternate sides', reps: '8 each side', type: 'dynamic', muscle: 'glutes, hips & lower back', cue: 'Briefly guide one knee toward your chest, release, and step into the other side.', sideMode: 'alternating', image_url: '/stretches/knee-to-chest.webp' },
  { id: 'lateral-lunge-shifts', name: 'Lateral Lunge Shifts', duration: 35, durationLabel: '35 sec · alternate sides', reps: '8 each side', type: 'dynamic', muscle: 'adductors, glutes & quads', cue: 'Shift into one hip with the other leg long, then move smoothly across to the other side.', sideMode: 'alternating', image_url: '/stretches/lateral-lunge-hold.webp' },
  { id: 'cat-cow-flow', name: 'Cat-Cow Flow', duration: 30, durationLabel: '30 sec', reps: '8 slow cycles', type: 'dynamic', muscle: 'spine & core', cue: 'Move gently between a rounded and extended spine while breathing steadily.', sideMode: 'bilateral', image_url: '/stretches/cat-cow.webp' },
  { id: 'pelvic-tilts', name: 'Pelvic Tilts', duration: 30, durationLabel: '30 sec', reps: '10 slow reps', type: 'dynamic', muscle: 'lower back & deep core', cue: 'Gently tip your pelvis to flatten the lower back, then return to neutral.', sideMode: 'bilateral', image_url: '/stretches/pelvic-tilt.webp' },
  { id: 'downward-dog-pedals', name: 'Downward Dog Pedals', duration: 30, durationLabel: '30 sec · alternate sides', reps: 'Alternate continuously', type: 'dynamic', muscle: 'calves, ankles & hamstrings', cue: 'Lift your hips and alternate bending each knee while keeping the heel movement gentle.', sideMode: 'alternating', image_url: '/stretches/downward-dog.webp' },
  { id: 'glute-bridge-reps', name: 'Glute Bridge Reps', duration: 35, durationLabel: '35 sec', reps: '10 controlled reps', type: 'dynamic', muscle: 'glutes, hips & core', cue: 'Press through both feet, lift your hips under control, and lower without arching your back.', sideMode: 'bilateral', image_url: '/stretches/bridge-hold.webp' },
].map(withSideMetadata)

export const postRunStretches = [
  { id: 'standing-quad', name: 'Standing Quad Stretch', duration: 30, durationLabel: '30 sec each side', reps: 'Hold 30s each side', type: 'static', muscle: 'quadriceps', cue: 'Stand on one leg, bring the other heel toward your glute, and keep your knees close.' },
  { id: 'hamstring-stretch', name: 'Hamstring Stretch', duration: 30, durationLabel: '30 sec each side', reps: 'Hold 30s each side', type: 'static', muscle: 'hamstrings', cue: 'Extend one leg and hinge forward with a long spine until the hamstring feels a gentle stretch.' },
  { id: 'calf-stretch', name: 'Calf Stretch', duration: 30, durationLabel: '30 sec each side', reps: 'Hold 30s each side', type: 'static', muscle: 'calves & achilles', cue: 'Place one leg behind you with the heel down and lean toward a wall.' },
  { id: 'hip-flexor', name: 'Hip Flexor Stretch', duration: 30, durationLabel: '30 sec each side', reps: 'Hold 30s each side', type: 'static', muscle: 'hip flexors', cue: 'Kneel in a lunge, tuck your pelvis slightly, and shift forward without arching your back.' },
  { id: 'figure-four', name: 'Figure Four (Piriformis)', duration: 30, durationLabel: '30 sec each side', reps: 'Hold 30s each side', type: 'static', muscle: 'glutes & piriformis', cue: 'Cross one ankle over the opposite knee and draw the supporting leg toward you.' },
  { id: 'childs-pose', name: "Child's Pose", duration: 45, durationLabel: '45 sec', reps: 'Hold 45 seconds', type: 'static', muscle: 'lower back, hips & quads', cue: 'Sit your hips toward your heels, reach forward, and breathe into your lower back.' },
  { id: 'butterfly', name: 'Butterfly Stretch', duration: 45, durationLabel: '45 sec', reps: 'Hold 45 seconds', type: 'static', muscle: 'inner thighs & hips', cue: 'Bring the soles of your feet together, sit tall, and let your knees lower comfortably.', image_url: '/stretches/butterfly.webp' },
  { id: 'pigeon-pose', name: 'Pigeon Pose', duration: 30, durationLabel: '30 sec each side', reps: 'Hold 30s each side', type: 'static', muscle: 'glutes & outer hips', cue: 'Fold over the front shin only as far as your hips and knee remain comfortable.', image_url: '/stretches/pigeon-pose.webp' },
  { id: 'knee-to-chest', name: 'Knee-to-Chest Stretch', duration: 30, durationLabel: '30 sec each side', reps: 'Hold 30s each side', type: 'static', muscle: 'glutes & lower back', cue: 'Lie back and draw one knee toward your chest while the other leg stays relaxed.', image_url: '/stretches/knee-to-chest.webp' },
  { id: 'supine-twist', name: 'Supine Spinal Twist', duration: 30, durationLabel: '30 sec each side', reps: 'Hold 30s each side', type: 'static', muscle: 'lower back & outer hips', cue: 'Guide one bent knee across your body while keeping both shoulders relaxed.', image_url: '/stretches/supine-twist.webp' },
  { id: 'downward-dog', name: 'Downward Dog', duration: 40, durationLabel: '40 sec', reps: 'Hold 40 seconds', type: 'static', muscle: 'calves, hamstrings & shoulders', cue: 'Lift your hips into an inverted V and gently pedal your heels without forcing them down.', image_url: '/stretches/downward-dog.webp' },
  { id: 'standing-it-band', name: 'Standing IT Band Stretch', duration: 30, durationLabel: '30 sec each side', reps: 'Hold 30s each side', type: 'static', muscle: 'outer hips & thighs', cue: 'Cross one leg behind the other and lean away until the outside hip feels a gentle stretch.', image_url: '/stretches/standing-it-band.webp' },
  { id: 'recovery-kneeling-quad', name: 'Kneeling Quad Stretch', duration: 30, durationLabel: '30 sec each side', reps: 'Hold 30s each side', type: 'static', muscle: 'quads & hip flexors', cue: 'Tuck your pelvis in a supported kneel and ease forward while the front knee stays steady.', sideMode: 'each-side', image_url: '/stretches/kneeling-quad.webp' },
  { id: 'recovery-inner-thigh', name: 'Inner Thigh Stretch', duration: 30, durationLabel: '30 sec each side', reps: 'Hold 30s each side', type: 'static', muscle: 'adductors & hips', cue: 'Shift toward one bent knee while the other leg stays long and the foot remains planted.', sideMode: 'each-side', image_url: '/stretches/inner-thigh-stretch.webp' },
  { id: 'recovery-seated-hip-rotation', name: 'Seated Hip Rotations', duration: 30, durationLabel: '30 sec · alternate sides', reps: '8 controlled switches', type: 'mobility', muscle: 'hips & glutes', cue: 'Rotate both knees side to side through a smooth range that keeps your hips comfortable.', sideMode: 'alternating', image_url: '/stretches/seated-hip-rotation.webp' },
  { id: 'recovery-lateral-lunge', name: 'Lateral Lunge Hold', duration: 30, durationLabel: '30 sec each side', reps: 'Hold 30s each side', type: 'static', muscle: 'adductors, glutes & quads', cue: 'Sit into one hip with the opposite leg long, keeping the bent knee aligned with the foot.', sideMode: 'each-side', image_url: '/stretches/lateral-lunge-hold.webp' },
  { id: 'recovery-sumo-squat', name: 'Sumo Squat Hold', duration: 30, durationLabel: '30 sec', reps: 'Hold 30 seconds', type: 'static', muscle: 'hips, adductors & glutes', cue: 'Use a wide stance and settle into a shallow squat with your knees tracking over your toes.', sideMode: 'bilateral', image_url: '/stretches/sumo-squat-hold.webp' },
  { id: 'recovery-cobra', name: 'Cobra Stretch', duration: 30, durationLabel: '30 sec', reps: 'Hold 30 seconds', type: 'static', muscle: 'abdominals & hip flexors', cue: 'Lift your chest only as far as your lower back stays comfortable and your shoulders stay down.', sideMode: 'bilateral', image_url: '/stretches/cobra.webp' },
  { id: 'recovery-pelvic-tilts', name: 'Pelvic Tilts', duration: 30, durationLabel: '30 sec', reps: '10 slow reps', type: 'mobility', muscle: 'lower back & deep core', cue: 'Move gently between a flattened lower back and neutral without pushing either end range.', sideMode: 'bilateral', image_url: '/stretches/pelvic-tilt.webp' },
  { id: 'recovery-cat-cow', name: 'Cat-Cow', duration: 40, durationLabel: '40 sec', reps: '8 slow cycles', type: 'mobility', muscle: 'spine & core', cue: 'Round and extend your spine slowly, keeping both positions comfortable and controlled.', sideMode: 'bilateral', image_url: '/stretches/cat-cow.webp' },
  { id: 'recovery-trunk-rotation', name: 'Seated Trunk Rotation', duration: 30, durationLabel: '30 sec each side', reps: 'Hold 30s each side', type: 'static', muscle: 'upper back & core', cue: 'Sit tall and turn gently through your upper back without pulling into the end range.', sideMode: 'each-side', image_url: '/stretches/trunk-rotation.webp' },
].map(withSideMetadata)
