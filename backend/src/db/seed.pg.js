const pg = require('./postgres');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Lifetime Pro accounts — these emails get is_pro=1 on every deploy (idempotent)
const PRO_EMAILS = [
  'bryanmadera@me.com', // Bryan — founder, lifetime Pro forever
];

/**
 * Idempotent seed for PostgreSQL
 * Checks if demo user exists before seeding
 */
async function runSeed() {
  try {
    // Check if demo user already exists
    const existing = await pg.getOne(
      'SELECT id FROM users WHERE email = $1 LIMIT 1',
      ['demo@forge.app']
    );

    if (existing) {
      console.log('FORGE DB already seeded — skipping.');
      return;
    }

    const userId = uuidv4();

    // Insert demo user
    await pg.query(
      `INSERT INTO users (id, name, email, password_hash, weekly_miles_current, goal_type, comeback_mode,
        injury_notes, onboarded, coach_personality, run_days_per_week, lift_days_per_week)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        userId,
        'Bryan',
        'demo@forge.app',
        bcrypt.hashSync('demo1234', 10),
        15,
        'comeback',
        1,
        'Right leg injury Dec 2025, returning to training. Currently doing easy miles only.',
        1,
        'mentor',
        4,
        3,
      ]
    );

    // Recent runs
    const runs = [
      {
        date: '2026-02-19',
        type: 'easy',
        miles: 3.1,
        secs: 1980,
        effort: 4,
        feedback:
          'Solid easy effort. Your pace looked controlled — exactly what comeback mode calls for. Keep the effort conversational and your leg will thank you.',
      },
      {
        date: '2026-02-21',
        type: 'easy',
        miles: 4.0,
        secs: 2640,
        effort: 5,
        feedback:
          'Good progression from Thursday. Four miles at an easy effort is meaningful volume for where you are right now. The consistency is building your base.',
      },
      {
        date: '2026-02-22',
        type: 'recovery',
        miles: 2.0,
        secs: 1440,
        effort: 3,
        feedback:
          'Smart call on the recovery run. Short and slow is doing real work — flushing fatigue and keeping the habit alive without stressing the leg.',
      },
    ];

    for (const r of runs) {
      await pg.query(
        `INSERT INTO runs (id, user_id, date, type, distance_miles, duration_seconds, perceived_effort, ai_feedback)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [uuidv4(), userId, r.date, r.type, r.miles, r.secs, r.effort, r.feedback]
      );
    }

    // Recent lifts
    const lifts = [
      {
        date: '2026-02-20',
        groups: JSON.stringify(['chest', 'shoulders', 'arms']),
        intensity: 'moderate',
      },
      {
        date: '2026-02-22',
        groups: JSON.stringify(['back', 'core']),
        intensity: 'moderate',
      },
    ];

    for (const l of lifts) {
      await pg.query(
        `INSERT INTO lifts (id, user_id, date, muscle_groups, intensity)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), userId, l.date, l.groups, l.intensity]
      );
    }

    console.log('✅ FORGE seeded.');
    console.log('   Login: demo@forge.app / demo1234');
    console.log('   Profile: Bryan — comeback mode, 15mi/week, mentor coach');
  } catch (error) {
    console.error('❌ Seed failed:', error.message);
    throw error;
  }

  // Grant lifetime Pro to whitelisted emails (runs every deploy — idempotent)
  try {
    for (const email of PRO_EMAILS) {
      const result = await pg.query(
        'UPDATE users SET is_pro=1 WHERE email = $1',
        [email]
      );
      if (result.rowCount > 0) {
        console.log(`⭐ Pro granted: ${email}`);
      }
    }
  } catch (err) {
    // Non-fatal — log and continue
    console.warn('Pro grant step skipped:', err.message);
  }
}

// Run seed if this is the main module
if (require.main === module) {
  runSeed()
    .then(() => {
      console.log('Seed runner finished.');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Fatal seed error:', error);
      process.exit(1);
    });
}

module.exports = { runSeed };
