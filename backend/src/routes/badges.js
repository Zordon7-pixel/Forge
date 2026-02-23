const router = require('express').Router()
const db = require('../db')
const auth = require('../middleware/auth')

// ─── Seed badges on module load ───────────────────────────────────────────────
function seedBadges() {
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM badges').get()
  if (existing.cnt > 0) return

  const insert = db.prepare(`
    INSERT OR IGNORE INTO badges (slug, name, description, icon, category, requirement_type, requirement_value)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const badges = [
    ['first-run',  'First Run',          'You completed your first run!',  'Flame',   'achievement', 'run_count',   1],
    ['10-runs',    '10 Runs Club',        '10 runs completed',              'Zap',     'achievement', 'run_count',   10],
    ['50-runs',    '50 Runs Club',        '50 runs completed',              'Award',   'achievement', 'run_count',   50],
    ['century',    'Century',             '100 runs completed',             'Crown',   'achievement', 'run_count',   100],
    ['first-mile', 'First Mile',          'You ran your first mile!',       'Star',    'achievement', 'total_miles', 1],
    ['marathon',   'Marathon Distance',   '26.2 miles total',               'Trophy',  'achievement', 'total_miles', 26.2],
    ['100-miles',  '100 Mile Club',       '100 total miles logged',         'Medal',   'achievement', 'total_miles', 100],
    ['500-miles',  '500 Mile Club',       '500 total miles logged',         'Crown',   'achievement', 'total_miles', 500],
    ['week-warrior','Week Warrior',       '7-day run streak',               'Flame',   'monthly',     'streak',      7],
    ['iron-will',  'Iron Will',           '30-day run streak',              'Zap',     'monthly',     'streak',      30],
    ['pr-breaker', 'PR Breaker',          'You set a personal record',      'Trophy',  'achievement', 'pr',          1],
    ['new-year',   'New Year Runner',     'Ran on January 1st',             'Star',    'holiday',     'new_year',    1],
  ]

  const doInsert = db.transaction(() => {
    for (const b of badges) insert.run(...b)
  })
  doInsert()
}

seedBadges()

// ─── Helper: compute user stats ──────────────────────────────────────────────
function getUserStats(userId) {
  const runCount = db.prepare('SELECT COUNT(*) as cnt FROM runs WHERE user_id = ?').get(userId).cnt
  const milesRow = db.prepare('SELECT COALESCE(SUM(distance_miles),0) as total FROM runs WHERE user_id = ?').get(userId)
  const totalMiles = milesRow.total || 0

  // Streak: consecutive days ending today (or yesterday)
  const runDates = db.prepare(`
    SELECT DISTINCT date(date) as d FROM runs WHERE user_id = ? ORDER BY d DESC
  `).all(userId).map(r => r.d)

  let streak = 0
  if (runDates.length > 0) {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    let cursor = new Date(today)
    // allow streak to start from today or yesterday
    const latest = new Date(runDates[0])
    latest.setHours(0, 0, 0, 0)
    const diffDays = Math.floor((today - latest) / 86400000)
    if (diffDays <= 1) {
      cursor = new Date(latest)
      for (const d of runDates) {
        const day = new Date(d)
        day.setHours(0, 0, 0, 0)
        const diff = Math.floor((cursor - day) / 86400000)
        if (diff === 0) { streak++; cursor = new Date(day); }
        else if (diff === 1) { streak++; cursor = new Date(day); }
        else break
      }
    }
  }

  const prCount = db.prepare('SELECT COUNT(*) as cnt FROM personal_records WHERE user_id = ?').get(userId).cnt

  // Check new year run
  const newYearRun = db.prepare(`
    SELECT COUNT(*) as cnt FROM runs WHERE user_id = ? AND strftime('%m-%d', date) = '01-01'
  `).get(userId).cnt > 0

  return { runCount, totalMiles, streak, prCount, newYearRun }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/badges — all badges with earned status for current user
router.get('/', auth, (req, res) => {
  const userId = req.user.id
  const badges = db.prepare(`
    SELECT b.*,
      ub.earned_at,
      CASE WHEN ub.id IS NOT NULL THEN 1 ELSE 0 END as earned
    FROM badges b
    LEFT JOIN user_badges ub ON b.id = ub.badge_id AND ub.user_id = ?
    ORDER BY b.category, b.id
  `).all(userId)
  res.json({ badges })
})

// POST /api/badges/check — auto-award earned badges
router.post('/check', auth, (req, res) => {
  const userId = req.user.id
  const stats = getUserStats(userId)
  const allBadges = db.prepare('SELECT * FROM badges').all()

  const insert = db.prepare(`
    INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)
  `)

  const newlyEarned = []

  const award = db.transaction(() => {
    for (const badge of allBadges) {
      let earned = false
      switch (badge.requirement_type) {
        case 'run_count':
          earned = stats.runCount >= badge.requirement_value
          break
        case 'total_miles':
          earned = stats.totalMiles >= badge.requirement_value
          break
        case 'streak':
          earned = stats.streak >= badge.requirement_value
          break
        case 'pr':
          earned = stats.prCount >= badge.requirement_value
          break
        case 'new_year':
          earned = stats.newYearRun
          break
        default:
          earned = false
      }

      if (earned) {
        const result = insert.run(userId, badge.id)
        if (result.changes > 0) newlyEarned.push(badge)
      }
    }
  })

  award()
  res.json({ awarded: newlyEarned, stats })
})

// GET /api/badges/leaderboard — top 10 users by total miles
router.get('/leaderboard', auth, (req, res) => {
  const top = db.prepare(`
    SELECT
      u.id,
      COALESCE(u.username, u.name) as runner,
      COALESCE(SUM(r.distance_miles), 0) as total_miles,
      COUNT(DISTINCT ub.badge_id) as badge_count
    FROM users u
    LEFT JOIN runs r ON r.user_id = u.id
    LEFT JOIN user_badges ub ON ub.user_id = u.id
    GROUP BY u.id
    ORDER BY total_miles DESC
    LIMIT 10
  `).all()

  res.json({ leaderboard: top })
})

// GET /api/badges/seasonal — seasonal badges with progress and earned status
router.get('/seasonal', auth, (req, res) => {
  const now = new Date()
  const year = now.getFullYear()
  const todayStr = now.toISOString().slice(0, 10)

  const badges = db.prepare("SELECT * FROM badges WHERE category='seasonal' ORDER BY window_start ASC").all()

  const enriched = badges.map(badge => {
    // Build full date strings for current year
    const start = `${year}-${badge.window_start}`
    const end = `${year}-${badge.window_end}`
    const startDate = new Date(start)
    const endDate = new Date(end)
    endDate.setHours(23, 59, 59)

    // Determine status
    let status = 'upcoming'
    let daysRemaining = null
    let daysUntilStart = null
    if (now >= startDate && now <= endDate) {
      status = 'active'
      daysRemaining = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24))
    } else if (now > endDate) {
      status = 'past'
    } else {
      daysUntilStart = Math.ceil((startDate - now) / (1000 * 60 * 60 * 24))
    }

    // Check if earned
    const userBadge = db.prepare("SELECT * FROM user_badges WHERE user_id=? AND badge_id=?").get(req.user.id, badge.id)
    if (userBadge) status = 'earned'

    // Calculate progress
    let progress = 0
    if (badge.requirement_type === 'miles_in_window') {
      const result = db.prepare("SELECT COALESCE(SUM(distance_miles),0) as total FROM runs WHERE user_id=? AND date >= ? AND date <= ?").get(req.user.id, start, end)
      progress = result.total || 0
    } else if (badge.requirement_type === 'workouts_in_window') {
      const result = db.prepare("SELECT COUNT(*) as cnt FROM workout_sessions WHERE user_id=? AND started_at >= ? AND started_at <= ? AND ended_at IS NOT NULL").get(req.user.id, start, end)
      progress = result.cnt || 0
    }

    // Auto-award if progress meets requirement and not yet earned
    if (!userBadge && progress >= badge.requirement_value) {
      try {
        db.prepare("INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?,?)").run(req.user.id, badge.id)
        status = 'earned'
      } catch {}
    }

    return {
      ...badge,
      window_start_full: start,
      window_end_full: end,
      status,
      progress: Math.min(progress, badge.requirement_value),
      days_remaining: daysRemaining,
      days_until_start: daysUntilStart,
      earned: status === 'earned',
      earned_at: userBadge?.earned_at || null,
    }
  })

  // Sort: active first, then upcoming, then earned, then past
  const order = { active: 0, upcoming: 1, earned: 2, past: 3 }
  enriched.sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4))

  res.json({ badges: enriched })
})

module.exports = router
