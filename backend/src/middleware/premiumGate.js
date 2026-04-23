const { dbGet } = require('../db');

/**
 * Middleware that blocks free-tier users from premium-only routes.
 * Returns 402 with upgrade prompt if user is not Pro.
 */
function requirePremium(featureName) {
  return async (req, res, next) => {
    try {
      const user = await dbGet('SELECT is_pro FROM users WHERE id = ?', [req.user.id]);
      if (user?.is_pro) return next();

      return res.status(402).json({
        error: `${featureName || 'This feature'} requires a Forge Pro subscription.`,
        feature: featureName || 'premium',
        upgrade: true,
      });
    } catch (err) {
      console.error('Premium gate error:', err.message);
      return res.status(500).json({ error: 'Failed to verify subscription status' });
    }
  };
}

module.exports = { requirePremium };
