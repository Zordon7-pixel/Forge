const jwt = require('jsonwebtoken');
const { dbGet, runWithUserContext } = require('../db');

async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  let user;
  try {
    user = jwt.verify(header.slice(7), process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const account = await dbGet('SELECT id FROM users WHERE id = ?', [user.id]);
    if (!account) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = user;
    return runWithUserContext(user.id, next);
  } catch (err) {
    console.error('[auth] account verification failed:', err.message);
    return res.status(503).json({ error: 'Authentication is temporarily unavailable.' });
  }
}

module.exports = auth;
