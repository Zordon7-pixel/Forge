require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');

// Refuse to start without JWT_SECRET
if (!process.env.JWT_SECRET) {
  console.error('[SECURITY] JWT_SECRET env var not set. Refusing to start.');
  process.exit(1);
}

const { initDb } = require('./db');
const app = express();

// CORS — restrict to known origin in production
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : ['http://localhost:4000', 'http://localhost:4001', 'http://localhost:4002',
     'http://localhost:5173', 'http://100.102.219.60:4000', 'http://100.102.219.60:4001', 'http://100.102.219.60:4002',
     'https://forge-production-773f.up.railway.app', 'https://forgeathlete.app'];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(helmet({ contentSecurityPolicy: false }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/auth',        authLimiter, require('./routes/auth'));
app.use('/api/users',       require('./routes/users'));
app.use('/api/runs',        require('./routes/runs'));
app.use('/api/lifts',       require('./routes/lifts'));
app.use('/api/workouts',    require('./routes/workouts'));
app.use('/api/exercises',   require('./routes/exercises'));
app.use('/api/plans',       require('./routes/plans'));
app.use('/api/plan',        require('./routes/plans'));
app.use('/api/coach',       require('./routes/coach'));
app.use('/api/diagnostics', require('./routes/diagnostics'));
app.use('/api/feedback',    require('./routes/feedback'));
app.use('/api/checkin',     require('./routes/checkin'));
app.use('/api/prs',         require('./routes/prs'));
app.use('/api/badges',      require('./routes/badges'));
app.use('/api/challenges',  require('./routes/challenges'));
app.use('/api/social',      require('./routes/social'));
app.use('/api/ai',          require('./routes/ai'));
app.use('/api/community',   require('./routes/community'));
app.use('/api/journal',     require('./routes/journal'));
app.use('/api/milestones',  require('./routes/milestones'));
app.use('/api/watch-sync',  require('./routes/watchSync'));
app.use('/api/races',       require('./routes/races'));
app.use('/api/routes',      require('./routes/routes'));
app.use('/api/gear',        require('./routes/gear'));
app.use('/api/stretches',   require('./routes/stretches'));
app.use('/api/injury',      require('./routes/injury'));
app.use('/api/recap',       require('./routes/recap'));

// Serve frontend
const dist = path.join(__dirname, '../../frontend/dist');
app.use(express.static(dist));
app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));

const PORT = process.env.PORT || 4002;

initDb()
  .then(async () => {
    // Seed demo data after DB is ready
    try { await require('./db/seed').runSeed(); } catch (e) { console.error('Seed error:', e.message); }
    try { await require('./db/exercises-seed').seedExercises(); } catch (e) { console.error('Exercise seed error:', e.message); }
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`FORGE running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('[FATAL] DB init failed:', err);
    process.exit(1);
  });
