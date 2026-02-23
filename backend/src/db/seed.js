const { dbGet, dbRun } = require('./index');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

function rand(min, max) { return Math.random() * (max - min) + min; }

async function runSeed() {
  const email = 'demo@forge.app';
  let user = await dbGet('SELECT * FROM users WHERE email=?', [email]);

  if (!user) {
    const userId = uuidv4();
    await dbRun(`
      INSERT INTO users (id, name, email, password_hash, weekly_miles_current, goal_type, comeback_mode,
        injury_notes, onboarded, coach_personality, run_days_per_week, lift_days_per_week)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId, 'Bryan Demo', email, bcrypt.hashSync('demo1234', 10),
      22, 'race', 0,
      'Healthy, preparing for a half marathon.',
      1, 'mentor', 4, 3
    ]);
    user = await dbGet('SELECT * FROM users WHERE id=?', [userId]);
  }

  const userId = user.id;

  const runCountRow = await dbGet('SELECT COUNT(*) as c FROM runs WHERE user_id=?', [userId]);
  if (Number(runCountRow?.c || 0) < 30) {
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      if (d.getDay() === 2 || d.getDay() === 5 || d.getDay() === 0) continue;
      const date = d.toISOString().slice(0, 10);
      const exists = await dbGet('SELECT id FROM runs WHERE user_id=? AND date=?', [userId, date]);
      if (exists) continue;
      const miles = Number(rand(2, 8).toFixed(2));
      const paceSec = rand(500, 680);
      const duration = Math.round(miles * paceSec);
      const effort = Math.round(rand(4, 8));
      const type = effort >= 7 ? 'tempo' : (miles > 6 ? 'long' : 'easy');
      await dbRun(
        `INSERT INTO runs (id, user_id, date, type, distance_miles, duration_seconds, perceived_effort, notes, calories)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), userId, date, type, miles, duration, effort, 'Seeded demo run', Math.round(0.75 * 185 * miles)]
      );
    }
  }

  const liftCountRow = await dbGet('SELECT COUNT(*) as c FROM lifts WHERE user_id=?', [userId]);
  if (Number(liftCountRow?.c || 0) < 15) {
    const groups = [
      ['chest', 'triceps'], ['back', 'biceps'], ['legs', 'glutes'], ['shoulders', 'core'], ['full body']
    ];
    for (let i = 0; i < 15; i++) {
      const d = new Date();
      d.setDate(d.getDate() - (i * 2));
      const date = d.toISOString().slice(0, 10);
      const exists = await dbGet('SELECT id FROM lifts WHERE user_id=? AND date=?', [userId, date]);
      if (exists) continue;
      const g = groups[i % groups.length];
      await dbRun(
        'INSERT INTO lifts (id, user_id, date, muscle_groups, intensity, exercise_name, sets, reps, weight_lbs, notes) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [uuidv4(), userId, date, JSON.stringify(g), i % 3 === 0 ? 'hard' : 'moderate', 'Strength Session', 4, 8 + (i % 4), 95 + (i % 6) * 10, 'Seeded demo lift']
      );
    }
  }

  const checkinCountRow = await dbGet('SELECT COUNT(*) as c FROM daily_checkins WHERE user_id=?', [userId]);
  if (Number(checkinCountRow?.c || 0) < 7) {
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      await dbRun(
        'INSERT INTO daily_checkins (id, user_id, checkin_date, feeling, time_available, life_flags) VALUES (?,?,?,?,?,?) ON CONFLICT (user_id, checkin_date) DO NOTHING',
        [uuidv4(), userId, d.toISOString().slice(0, 10), 3 + (i % 3), 45 + (i % 3) * 15, JSON.stringify(i % 4 === 0 ? ['sore'] : [])]
      );
    }
  }

  const raceExists = await dbGet("SELECT id FROM race_events WHERE user_id=? AND status=?", [userId, 'upcoming']);
  if (!raceExists) {
    const d = new Date();
    d.setDate(d.getDate() + 45);
    await dbRun(
      `INSERT INTO race_events (id, user_id, race_name, race_date, distance_miles, location, goal_time_seconds, status, notes)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), userId, 'City Half Marathon', d.toISOString().slice(0, 10), 13.1, 'Local', 7200, 'upcoming', 'A-goal race']
    );
  }

  const planExists = await dbGet('SELECT id FROM training_plans WHERE user_id=?', [userId]);
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
      ]}]
    };
    await dbRun(
      'INSERT INTO training_plans (id, user_id, week_start, plan_json) VALUES (?,?,?,?)',
      [uuidv4(), userId, monday, JSON.stringify(plan)]
    );
  }

  console.log('FORGE seed ensured. Login: demo@forge.app / demo1234');
}

if (require.main === module) {
  runSeed().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runSeed };
