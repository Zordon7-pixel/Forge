const { dbGet, dbRun } = require('./index');

const EXERCISES = [
  // CHEST
  { name: 'Bench Press', muscle_group: 'chest', secondary_muscles: 'triceps, front shoulders', instructions: 'Lie flat on a bench. Grip the bar slightly wider than shoulder-width. Lower the bar to your mid-chest with control. Press back up explosively. Keep your feet flat on the floor and your back slightly arched.', how_to_image_url: 'https://wger.de/static/images/muscles/main/muscle-5.png' },
  { name: 'Incline Bench Press', muscle_group: 'chest', secondary_muscles: 'upper chest, front shoulders', instructions: 'Set bench to 30-45 degrees incline. Grip bar wider than shoulder-width. Lower to upper chest, press up. Focuses on upper chest development.', how_to_image_url: '' },
  { name: 'Dumbbell Fly', muscle_group: 'chest', secondary_muscles: 'front shoulders', instructions: 'Lie on a flat bench holding dumbbells above your chest with slight elbow bend. Open arms wide in an arc until you feel a chest stretch, then bring them back together.', how_to_image_url: '' },
  { name: 'Cable Chest Fly', muscle_group: 'chest', secondary_muscles: 'triceps', instructions: 'Set cables to shoulder height. Stand in the middle, step forward slightly. Bring handles together in front of your chest, squeezing hard at the peak.', how_to_image_url: '' },
  { name: 'Push-Ups', muscle_group: 'chest', secondary_muscles: 'triceps, core', instructions: 'Start in a plank position with hands slightly wider than shoulders. Lower your chest to the floor with control, keeping elbows at 45 degrees. Push back up. Keep your core tight throughout.', how_to_image_url: '' },
  { name: 'Dips (Chest)', muscle_group: 'chest', secondary_muscles: 'triceps', instructions: 'Use parallel bars. Lean slightly forward to target chest. Lower yourself until elbows are at 90 degrees, then push back up. Leaning forward shifts the focus to chest instead of triceps.', how_to_image_url: '' },
  // BACK
  { name: 'Pull-Ups', muscle_group: 'back', secondary_muscles: 'biceps, rear delts', instructions: 'Hang from a bar with hands shoulder-width apart, palms facing away. Pull your chest up to the bar by driving your elbows down and back. Lower with control.', how_to_image_url: '' },
  { name: 'Barbell Row', muscle_group: 'back', secondary_muscles: 'biceps, rear delts', instructions: 'Hinge at hips with a slight knee bend, back flat. Grip the bar just outside your legs. Pull the bar toward your lower chest/upper stomach by driving your elbows back. Lower with control.', how_to_image_url: '' },
  { name: 'Lat Pulldown', muscle_group: 'back', secondary_muscles: 'biceps', instructions: 'Sit at a cable machine, grip the bar wider than shoulder-width. Pull the bar down to your upper chest by driving your elbows toward your hips. Squeeze your lats at the bottom. Control the return.', how_to_image_url: '' },
  { name: 'Seated Cable Row', muscle_group: 'back', secondary_muscles: 'biceps, rear delts', instructions: 'Sit at a low cable row machine, feet on the platform, knees slightly bent. Pull the handle to your lower stomach by driving your elbows back, squeezing your shoulder blades together. Extend forward with control.', how_to_image_url: '' },
  { name: 'Deadlift', muscle_group: 'back', secondary_muscles: 'hamstrings, glutes, traps', instructions: 'Stand with bar over your mid-foot. Hinge down and grip just outside your legs. Chest up, back flat, push the floor away as you stand. Lock out at the top by squeezing your glutes. Lower with control.', how_to_image_url: '' },
  { name: 'Single-Arm Dumbbell Row', muscle_group: 'back', secondary_muscles: 'biceps', instructions: 'Place one knee and hand on a bench for support. With the free hand, grip a dumbbell and pull it toward your hip, keeping your elbow close to your body. Lower fully and repeat.', how_to_image_url: '' },
  // LEGS
  { name: 'Squat', muscle_group: 'legs', secondary_muscles: 'quads, hamstrings, glutes, core', instructions: 'Stand with feet shoulder-width apart, bar on your upper traps. Descend by pushing your hips back and down, keeping your chest up and knees tracking over your toes. Hit parallel or below, then drive back up through your heels.', how_to_image_url: '' },
  { name: 'Romanian Deadlift', muscle_group: 'legs', secondary_muscles: 'hamstrings, glutes', instructions: 'Hold a barbell or dumbbells at hip height. Hinge at the hips, pushing them back while lowering the weight along your legs. Feel a deep hamstring stretch, then drive your hips forward to return to standing.', how_to_image_url: '' },
  { name: 'Leg Press', muscle_group: 'legs', secondary_muscles: 'quads, hamstrings', instructions: 'Sit in the leg press machine with feet shoulder-width on the platform. Lower the weight until knees are at 90 degrees, then press back up. Do not lock out your knees at the top.', how_to_image_url: '' },
  { name: 'Lunges', muscle_group: 'legs', secondary_muscles: 'quads, hamstrings, glutes', instructions: 'Stand upright. Step forward with one leg and lower your back knee toward the floor. Keep your front shin vertical. Push back up through your front heel and alternate legs.', how_to_image_url: '' },
  { name: 'Leg Curl', muscle_group: 'legs', secondary_muscles: 'hamstrings', instructions: 'Lie face down on the machine. Curl your heels toward your glutes against the resistance. Hold briefly at the top, then lower slowly.', how_to_image_url: '' },
  { name: 'Leg Extension', muscle_group: 'legs', secondary_muscles: 'quads', instructions: 'Sit in the machine with the pad just above your ankles. Extend your legs fully by contracting your quads. Hold briefly, then lower slowly. Keep your back against the seat.', how_to_image_url: '' },
  { name: 'Hip Thrust', muscle_group: 'legs', secondary_muscles: 'glutes, hamstrings', instructions: 'Sit on the floor with your upper back on a bench and a barbell across your hips. Drive through your heels to push your hips up until your body is flat. Squeeze your glutes hard at the top, lower back down.', how_to_image_url: '' },
  { name: 'Calf Raises', muscle_group: 'legs', secondary_muscles: 'calves', instructions: 'Stand on the edge of a step with heels hanging off. Rise up onto your toes as high as possible, then lower below the step level for a full stretch. Keep a slight knee bend.', how_to_image_url: '' },
  // SHOULDERS
  { name: 'Overhead Press', muscle_group: 'shoulders', secondary_muscles: 'triceps, upper traps', instructions: 'Stand or sit with a barbell or dumbbells at shoulder height, just in front of your face. Press directly overhead until arms are fully extended. Lower back to shoulders with control.', how_to_image_url: '' },
  { name: 'Lateral Raise', muscle_group: 'shoulders', secondary_muscles: 'traps', instructions: 'Hold dumbbells at your sides with a slight elbow bend. Raise them out to the sides until at shoulder height, then lower slowly. Lead with your elbows, not your wrists.', how_to_image_url: '' },
  { name: 'Front Raise', muscle_group: 'shoulders', secondary_muscles: 'front delts', instructions: 'Hold dumbbells in front of your thighs. Raise one or both arms straight forward to shoulder height, then lower slowly. Keep a slight elbow bend throughout.', how_to_image_url: '' },
  { name: 'Rear Delt Fly', muscle_group: 'shoulders', secondary_muscles: 'rear delts, upper back', instructions: 'Hinge forward at the hips. Hold dumbbells hanging below you with a slight elbow bend. Raise them out to the sides, squeezing your rear delts at the top. Lower with control.', how_to_image_url: '' },
  { name: 'Arnold Press', muscle_group: 'shoulders', secondary_muscles: 'front delts, lateral delts', instructions: 'Start with dumbbells in front of your face, palms facing you. As you press up, rotate your palms to face forward. Reverse the rotation as you lower back down.', how_to_image_url: '' },
  // ARMS
  { name: 'Barbell Curl', muscle_group: 'arms', secondary_muscles: 'biceps, forearms', instructions: 'Stand with a barbell at hip height, palms facing away. Curl the bar up toward your chest by bending your elbows. Squeeze at the top, then lower slowly. Keep your elbows tight to your sides.', how_to_image_url: '' },
  { name: 'Hammer Curl', muscle_group: 'arms', secondary_muscles: 'biceps, brachialis', instructions: 'Hold dumbbells at your sides with palms facing each other (neutral grip). Curl up keeping the neutral grip throughout.', how_to_image_url: '' },
  { name: 'Tricep Pushdown', muscle_group: 'arms', secondary_muscles: 'triceps', instructions: 'At a cable machine with a rope or bar attachment. Keep elbows at your sides. Push the attachment down by extending your elbows fully. Squeeze at the bottom, return with control.', how_to_image_url: '' },
  { name: 'Skull Crushers', muscle_group: 'arms', secondary_muscles: 'triceps', instructions: 'Lie on a bench holding an EZ bar or dumbbells above your chest with arms extended. Bend only at the elbows to lower the weight toward your forehead. Extend back up.', how_to_image_url: '' },
  { name: 'Dips (Tricep)', muscle_group: 'arms', secondary_muscles: 'triceps, chest', instructions: 'Use parallel bars or a bench. Keep your body upright (not leaning forward). Lower yourself by bending your elbows to 90 degrees, then press back up.', how_to_image_url: '' },
  { name: 'Preacher Curl', muscle_group: 'arms', secondary_muscles: 'biceps', instructions: 'Sit at a preacher bench with your upper arms resting on the pad. Curl the bar or dumbbells up, focusing on the full range of motion. Lower completely for a full stretch at the bottom.', how_to_image_url: '' },
  // CORE
  { name: 'Plank', muscle_group: 'core', secondary_muscles: 'shoulders, glutes', instructions: "Hold a push-up position but resting on your forearms. Keep your body in a straight line from head to heels. Squeeze your core and glutes throughout. Don't let your hips sag or rise.", how_to_image_url: '' },
  { name: 'Crunches', muscle_group: 'core', secondary_muscles: 'hip flexors', instructions: 'Lie on your back with knees bent. Place hands behind your head lightly. Crunch your upper body toward your knees by contracting your abs. Lower slowly and repeat.', how_to_image_url: '' },
  { name: 'Hanging Leg Raise', muscle_group: 'core', secondary_muscles: 'hip flexors, abs', instructions: "Hang from a pull-up bar. Raise your legs straight (or bent at the knees for easier variation) until they are at least parallel to the floor. Lower with control — don't swing.", how_to_image_url: '' },
  { name: 'Russian Twist', muscle_group: 'core', secondary_muscles: 'obliques', instructions: 'Sit on the floor with knees bent and feet slightly elevated. Lean back slightly. Hold a weight and rotate your torso from side to side, touching the weight to the floor on each side.', how_to_image_url: '' },
  { name: 'Cable Crunch', muscle_group: 'core', secondary_muscles: 'abs', instructions: "Kneel at a cable machine with a rope attachment. Hold the rope behind your head. Crunch your elbows toward your knees by contracting your abs. Don't pull with your arms — the abs do the work.", how_to_image_url: '' },
  { name: 'Ab Wheel Rollout', muscle_group: 'core', secondary_muscles: 'lats, shoulders', instructions: 'Kneel on the floor holding an ab wheel. Roll forward as far as you can while keeping your back flat, then pull back in by contracting your core. Keep your hips from sagging.', how_to_image_url: '' },
];

async function seedExercises() {
  const existing = await dbGet('SELECT COUNT(*) as c FROM exercises');
  if (Number(existing?.c || 0) > 0) {
    console.log(`Exercises already seeded (${existing.c} records) — skipping`);
    return;
  }
  for (const item of EXERCISES) {
    await dbRun(
      `INSERT INTO exercises (id, name, muscle_group, secondary_muscles, instructions, how_to_image_url, is_system)
       VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING`,
      [require('crypto').randomBytes(8).toString('hex'), item.name, item.muscle_group, item.secondary_muscles, item.instructions, item.how_to_image_url]
    );
  }
  console.log(`Seeded ${EXERCISES.length} exercises`);
}

if (require.main === module) {
  seedExercises().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
module.exports = { seedExercises };
