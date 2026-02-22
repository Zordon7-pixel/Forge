const db = require('./index');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

function runSeed() {
  const existing = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (existing) { console.log('FORGE DB already seeded — skipping.'); return; }

  const userId = uuidv4();
  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, weekly_miles_current, goal_type, comeback_mode,
      injury_notes, onboarded, coach_personality, run_days_per_week, lift_days_per_week)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, 'Bryan', 'demo@forge.app', bcrypt.hashSync('demo1234', 10),
    15, 'comeback', 1,
    'Right leg injury Dec 2025, returning to training. Currently doing easy miles only.',
    1, 'mentor', 4, 3
  );

  // Recent runs
  const runs = [
    { date: '2026-02-19', type: 'easy',     miles: 3.1, secs: 1980, effort: 4, feedback: 'Solid easy effort. Your pace looked controlled — exactly what comeback mode calls for. Keep the effort conversational and your leg will thank you.' },
    { date: '2026-02-21', type: 'easy',     miles: 4.0, secs: 2640, effort: 5, feedback: 'Good progression from Thursday. Four miles at an easy effort is meaningful volume for where you are right now. The consistency is building your base.' },
    { date: '2026-02-22', type: 'recovery', miles: 2.0, secs: 1440, effort: 3, feedback: 'Smart call on the recovery run. Short and slow is doing real work — flushing fatigue and keeping the habit alive without stressing the leg.' },
  ];
  runs.forEach(r => {
    db.prepare(`INSERT INTO runs (id, user_id, date, type, distance_miles, duration_seconds, perceived_effort, ai_feedback)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(uuidv4(), userId, r.date, r.type, r.miles, r.secs, r.effort, r.feedback);
  });

  // Recent lifts
  const lifts = [
    { date: '2026-02-20', groups: JSON.stringify(['chest','shoulders','arms']), intensity: 'moderate' },
    { date: '2026-02-22', groups: JSON.stringify(['back','core']),              intensity: 'moderate' },
  ];
  lifts.forEach(l => {
    db.prepare(`INSERT INTO lifts (id, user_id, date, muscle_groups, intensity) VALUES (?, ?, ?, ?, ?)`)
      .run(uuidv4(), userId, l.date, l.groups, l.intensity);
  });

  console.log('✅ FORGE seeded.');
  console.log('   Login: demo@forge.app / demo1234');
  console.log('   Profile: Bryan — comeback mode, 15mi/week, mentor coach');
}

if (require.main === module) {
  runSeed();
  process.exit(0);
}

module.exports = { runSeed };
