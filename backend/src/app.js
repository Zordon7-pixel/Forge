require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');
const comebackRouter = require('./routes/comeback');

// Refuse to start without JWT_SECRET
if (!process.env.JWT_SECRET) {
  console.error('[SECURITY] JWT_SECRET env var not set. Refusing to start.');
  process.exit(1);
}

const { initDb } = require('./db');
const app = express();

// Trust Railway's reverse proxy so express-rate-limit can read X-Forwarded-For correctly
app.set('trust proxy', 1);

// Frontend static files served AFTER API routes to avoid intercepting /api/* paths
const dist = path.join(__dirname, '../../frontend/dist');

// CORS — restrict to known origin in production
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : ['http://localhost:4000', 'http://localhost:4001', 'http://localhost:4002',
     'http://localhost:5173', 'http://100.102.219.60:4000', 'http://100.102.219.60:4001', 'http://100.102.219.60:4002',
     'https://forge-production-773f.up.railway.app', 'https://forgeathlete.app'];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true
}));

// Stripe webhooks require the raw request body for signature verification.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(helmet({
  contentSecurityPolicy: {
    reportOnly: true,
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", ...allowedOrigins],
      imgSrc: ["'self'", 'data:', 'blob:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/auth/login',           authLimiter);
app.use('/api/auth/register',        authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password',  authLimiter);
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/consent',     require('./routes/consent'));
app.use('/api/users',       require('./routes/users'));
app.use('/api/runs',        require('./routes/runs'));
app.use('/api/lifts',       require('./routes/lifts'));
app.use('/api/workouts',    require('./routes/workouts'));
app.use('/api/exercises',   require('./routes/exercises'));
app.use('/api/plans',       require('./routes/plans'));
app.use('/api/plan',        require('./routes/plans'));
app.use('/api/coach',       require('./routes/coach'));
app.use('/api/diagnostics', require('./routes/diagnostics'));
app.use('/api/meta',        require('./routes/meta'));
app.use('/api/feedback',    require('./routes/feedback'));
app.use('/api/events',      require('./routes/events'));
app.use('/api/checkin',     require('./routes/checkin'));
app.use('/api/prs',         require('./routes/prs'));
app.use('/api/hybrid-prs',  require('./routes/hybridPrs'));
app.use('/api/social',      require('./routes/social'));
app.use('/api/ai',          require('./routes/ai'));
app.use('/api/milestones',  require('./routes/milestones'));
app.use('/api/watch-sync',  require('./routes/watchSync'));
app.use('/api/health',      require('./routes/health'));
app.use('/api/body',        require('./routes/bodyDrivers'));
app.use('/api/garmin',      require('./routes/garmin'));
app.use('/api/strava',      require('./routes/strava'));
app.use('/api/whoop',       require('./routes/whoop'));
app.use('/api/oura',        require('./routes/oura'));
app.use('/api/recovery',    require('./routes/recovery'));
app.use('/api/import',      require('./routes/import'));
app.use('/api/races',       require('./routes/races'));
app.use('/api/routes',      require('./routes/routes'));
app.use('/api/gear',        require('./routes/gear'));
app.use('/api/stretches',   require('./routes/stretches'));
app.use('/api/injury',      require('./routes/injury'));
app.use('/api/pt',          require('./routes/pt'));
app.use('/api/recap',       require('./routes/recap'));
app.use('/api/payments',    require('./routes/payments'));
app.use('/api/stripe',      require('./routes/stripe'));
app.use('/api/comp',        require('./routes/comp'));
app.use('/api',             comebackRouter);

// Public pages
app.use('/privacy', require('./routes/privacy'));

// Serve frontend static files after all API routes
app.use(express.static(dist));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(dist, 'index.html'));
});

const PORT = process.env.PORT || 4002;
const HOST = process.env.HOST || (process.env.RAILWAY_ENVIRONMENT ? '0.0.0.0' : '127.0.0.1');

initDb()
  .then(async () => {
    try {
      await require('./db/migrate').runAlwaysMigrations();
    } catch (err) {
      console.error('[FATAL] Always migrations failed:', err);
      process.exit(1);
    }

    // Seed demo data after DB is ready
    try { await require('./db/seed').runSeed(); } catch (e) { console.error('Seed error:', e.message); }
    try { await require('./db/exercises-seed').seedExercises(); } catch (e) { console.error('Exercise seed error:', e.message); }
    app.listen(PORT, HOST, () => {
      console.log(`FORGE running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    });
  })
  .catch(err => {
    console.error('[FATAL] DB init failed:', err);
    process.exit(1);
  });
