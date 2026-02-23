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

  const challengeCount = db.prepare('SELECT COUNT(*) as c FROM challenges').get();
  if (challengeCount.c === 0) {
    const featured = [
      { id: 'ch-appalachian', name: 'Appalachian Trail', description: 'Run the length of the Appalachian Trail — 2,190 miles through 14 states.', type: 'virtual_course', target_value: 2190, unit: 'miles', badge_color: '#22c55e', is_featured: 1, sort_order: 1 },
      { id: 'ch-camino', name: 'Camino de Santiago', description: 'Follow the ancient pilgrimage route across Spain — 485 miles.', type: 'virtual_course', target_value: 485, unit: 'miles', badge_color: '#3b82f6', is_featured: 1, sort_order: 2 },
      { id: 'ch-pct', name: 'Pacific Crest Trail', description: 'Run from Mexico to Canada — 2,650 miles of wilderness.', type: 'virtual_course', target_value: 2650, unit: 'miles', badge_color: '#8b5cf6', is_featured: 1, sort_order: 3 },
      { id: 'ch-boston', name: 'Boston Marathon', description: 'Cover the iconic 26.2 miles from Hopkinton to Boylston Street.', type: 'virtual_course', target_value: 26.2, unit: 'miles', badge_color: '#f59e0b', is_featured: 1, sort_order: 4 },
      { id: 'ch-inca', name: 'Inca Trail', description: 'Run the legendary Peruvian trail to Machu Picchu — 26 miles.', type: 'virtual_course', target_value: 26, unit: 'miles', badge_color: '#ef4444', is_featured: 1, sort_order: 5 },
      { id: 'ch-steps-weekly', name: '70K Step Week', description: 'Hit 70,000 steps in a single week.', type: 'step_weekly', target_value: 70000, unit: 'steps', badge_color: '#EAB308', is_featured: 0, sort_order: 6 },
      { id: 'ch-steps-daily', name: '10K Steps Daily', description: 'Hit your 10,000 step goal every day for a week.', type: 'step_streak', target_value: 7, unit: 'days', badge_color: '#EAB308', is_featured: 0, sort_order: 7 },
    ];
    const stmt = db.prepare('INSERT OR IGNORE INTO challenges (id, name, description, type, target_value, unit, badge_color, is_featured, sort_order) VALUES (?,?,?,?,?,?,?,?,?)');
    featured.forEach(c => stmt.run(c.id, c.name, c.description, c.type, c.target_value, c.unit, c.badge_color, c.is_featured, c.sort_order));
  }

  console.log('✅ FORGE seeded.');
  console.log('   Login: demo@forge.app / demo1234');
  console.log('   Profile: Bryan — comeback mode, 15mi/week, mentor coach');
}

if (require.main === module) {
  runSeed();
  process.exit(0);
}

module.exports = { runSeed };
