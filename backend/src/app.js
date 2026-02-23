require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

// Seed demo data on startup
try { require('./db/seed').runSeed(); } catch (e) { console.error('Seed error:', e.message); }
try { require('./db/exercises-seed').seedExercises(); } catch(e) { console.error('Exercise seed error:', e.message); }

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth',  require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/runs',  require('./routes/runs'));
app.use('/api/lifts', require('./routes/lifts'));
app.use('/api/workouts', require('./routes/workouts'));
app.use('/api/exercises', require('./routes/exercises'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/coach', require('./routes/coach'));
app.use('/api/diagnostics', require('./routes/diagnostics'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/checkin', require('./routes/checkin'));
app.use('/api/prs', require('./routes/prs'));
app.use('/api/badges', require('./routes/badges'));

// Serve frontend
const dist = path.join(__dirname, '../../frontend/dist');
app.use(express.static(dist));
app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));

const PORT = process.env.PORT || 4002;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🔥 FORGE running on http://localhost:${PORT}`);
});
