const db = require('./index');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

function rand(min, max) { return Math.random() * (max - min) + min; }

function runSeed() {
  const email = 'demo@forge.app';
  let user = db.prepare('SELECT * FROM users WHERE email=?').get(email);

  if (!user) {
    const userId = uuidv4();
    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, weekly_miles_current, goal_type, comeback_mode,
        injury_notes, onboarded, coach_personality, run_days_per_week, lift_days_per_week)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId, 'Bryan Demo', email, bcrypt.hashSync('demo1234', 10),
      22, 'race', 0,
      'Healthy, preparing for a half marathon.',
      1, 'mentor', 4, 3
    );
    user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  }

  const userId = user.id;

  const runCount = db.prepare('SELECT COUNT(*) as c FROM runs WHERE user_id=?').get(userId).c;
  if (runCount < 30) {
    const insertRun = db.prepare(`INSERT INTO runs (id, user_id, date, type, distance_miles, duration_seconds, perceived_effort, notes, calories)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      if (d.getDay() === 2 || d.getDay() === 5 || d.getDay() === 0) continue;
      const date = d.toISOString().slice(0, 10);
      const exists = db.prepare('SELECT id FROM runs WHERE user_id=? AND date=?').get(userId, date);
      if (exists) continue;
      const miles = Number(rand(2, 8).toFixed(2));
      const paceSec = rand(500, 680);
      const duration = Math.round(miles * paceSec);
      const effort = Math.round(rand(4, 8));
      const type = effort >= 7 ? 'tempo' : (miles > 6 ? 'long' : 'easy');
      insertRun.run(uuidv4(), userId, date, type, miles, duration, effort, 'Seeded demo run', Math.round(0.75 * 185 * miles));
    }
  }

  const liftCount = db.prepare('SELECT COUNT(*) as c FROM lifts WHERE user_id=?').get(userId).c;
  if (liftCount < 15) {
    const groups = [
      ['chest', 'triceps'], ['back', 'biceps'], ['legs', 'glutes'], ['shoulders', 'core'], ['full body']
    ];
    const insertLift = db.prepare('INSERT INTO lifts (id, user_id, date, muscle_groups, intensity, exercise_name, sets, reps, weight_lbs, notes) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < 15; i++) {
      const d = new Date();
      d.setDate(d.getDate() - (i * 2));
      const date = d.toISOString().slice(0, 10);
      const exists = db.prepare('SELECT id FROM lifts WHERE user_id=? AND date=?').get(userId, date);
      if (exists) continue;
      const g = groups[i % groups.length];
      insertLift.run(uuidv4(), userId, date, JSON.stringify(g), i % 3 === 0 ? 'hard' : 'moderate', 'Strength Session', 4, 8 + (i % 4), 95 + (i % 6) * 10, 'Seeded demo lift');
    }
  }

  const checkinCount = db.prepare('SELECT COUNT(*) as c FROM daily_checkins WHERE user_id=?').get(userId).c;
  if (checkinCount < 7) {
    const stmt = db.prepare('INSERT OR IGNORE INTO daily_checkins (id, user_id, checkin_date, feeling, time_available, life_flags) VALUES (?,?,?,?,?,?)');
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      stmt.run(uuidv4(), userId, d.toISOString().slice(0, 10), 3 + (i % 3), 45 + (i % 3) * 15, JSON.stringify(i % 4 === 0 ? ['sore'] : []));
    }
  }

  const raceExists = db.prepare('SELECT id FROM race_events WHERE user_id=? AND status=?').get(userId, 'upcoming');
  if (!raceExists) {
    const d = new Date();
    d.setDate(d.getDate() + 45);
    db.prepare(`INSERT INTO race_events (id, user_id, race_name, race_date, distance_miles, location, goal_time_seconds, status, notes)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(uuidv4(), userId, 'City Half Marathon', d.toISOString().slice(0, 10), 13.1, 'Local', 7200, 'upcoming', 'A-goal race');
  }

  const planExists = db.prepare('SELECT id FROM training_plans WHERE user_id=?').get(userId);
  if (!planExists) {
    const monday = (() => {
      const dt = new Date();
      const day = dt.getDay();
      const diff = dt.getDate() - day + (day === 0 ? -6 : 1);
      dt.setDate(diff);
      return dt.toISOString().slice(0, 10);
    })();

    const plan = {
      weeks: [{ week: 1, theme: 'Race Build', total_miles: 24, days: [
        { day: 'Mon', type: 'easy', distance_miles: 4, description: 'Easy aerobic run', rest: false },
        { day: 'Tue', type: 'strength', workout_type: 'strength', distance_miles: 0, description: 'Strength training', rest: false },
        { day: 'Wed', type: 'tempo', distance_miles: 5, description: 'Tempo progression', rest: false },
        { day: 'Thu', type: 'rest', distance_miles: 0, description: 'Recovery day', rest: true },
        { day: 'Fri', type: 'easy', distance_miles: 3, description: 'Easy shakeout', rest: false },
        { day: 'Sat', type: 'long', distance_miles: 8, description: 'Long run', rest: false },
        { day: 'Sun', type: 'rest', distance_miles: 0, description: 'Rest day', rest: true }
      ] }]
    };
    db.prepare('INSERT INTO training_plans (id, user_id, week_start, plan_json) VALUES (?,?,?,?)').run(uuidv4(), userId, monday, JSON.stringify(plan));
  }

  console.log('FORGE seed ensured. Login: demo@forge.app / demo1234');
}

if (require.main === module) {
  runSeed();
  process.exit(0);
}

module.exports = { runSeed };