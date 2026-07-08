const { randomUUID } = require('crypto');
const router = require('express').Router();
const { dbGet, dbRun, withTransaction } = require('../db');
const auth = require('../middleware/auth');

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function adminGuard(req, res) {
  if (!process.env.ADMIN_TOKEN) {
    res.status(503).json({ error: 'admin disabled' });
    return false;
  }

  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }

  return true;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

router.post('/redeem', auth, async (req, res) => {
  const code = cleanString(req.body?.code);
  if (!code) return res.status(400).json({ error: 'code is required' });

  try {
    const result = await withTransaction(async (tx) => {
      const compCode = await tx.get(
        'SELECT code, max_redemptions, redeemed_count, grants_until, active FROM comp_codes WHERE code = ? FOR UPDATE',
        [code]
      );

      if (!compCode || !compCode.active) {
        throw httpError(404, 'Comp code not found');
      }

      const maxRedemptions = compCode.max_redemptions == null ? 1 : Number(compCode.max_redemptions);
      const redeemedCount = compCode.redeemed_count == null ? 0 : Number(compCode.redeemed_count);
      if (redeemedCount >= maxRedemptions) {
        throw httpError(409, 'Comp code has no redemptions remaining');
      }

      const existing = await tx.get(
        'SELECT id FROM comp_redemptions WHERE code = ? AND user_id = ?',
        [code, req.user.id]
      );
      if (existing) {
        throw httpError(409, 'Comp code already redeemed');
      }

      await tx.run(
        'INSERT INTO comp_redemptions (id, code, user_id) VALUES (?, ?, ?)',
        [randomUUID(), code, req.user.id]
      );
      await tx.run(
        'UPDATE comp_codes SET redeemed_count = redeemed_count + 1 WHERE code = ?',
        [code]
      );
      await tx.run(
        `UPDATE users
         SET is_pro = 1,
             subscription_status = 'comp',
             subscription_ends_at = ?
         WHERE id = ?`,
        [compCode.grants_until || null, req.user.id]
      );

      return { ok: true, pro: true, until: compCode.grants_until || null };
    });

    res.json(result);
  } catch (err) {
    console.error('[comp/redeem]', { userId: req.user?.id, code, error: err.message });
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'Failed to redeem comp code' });
  }
});

router.post('/grant', async (req, res) => {
  if (!adminGuard(req, res)) return;

  const email = cleanString(req.body?.email);
  const mintCode = cleanString(req.body?.mintCode);
  const until = cleanString(req.body?.until) || null;

  try {
    if (email) {
      const result = await dbRun(
        `UPDATE users
         SET is_pro = 1,
             subscription_status = 'comp',
             subscription_ends_at = ?
         WHERE lower(email) = lower(?)`,
        [until, email]
      );

      if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
      return res.json({ ok: true, pro: true, until });
    }

    if (mintCode) {
      const max = req.body?.max == null ? 1 : Number(req.body.max);
      if (!Number.isInteger(max) || max < 1) {
        return res.status(400).json({ error: 'max must be a positive integer' });
      }

      await dbRun(
        'INSERT INTO comp_codes (code, max_redemptions, grants_until) VALUES (?, ?, ?)',
        [mintCode, max, until]
      );
      const compCode = await dbGet(
        'SELECT code, max_redemptions, redeemed_count, grants_until, active FROM comp_codes WHERE code = ?',
        [mintCode]
      );

      return res.json({ ok: true, code: compCode });
    }

    res.status(400).json({ error: 'email or mintCode is required' });
  } catch (err) {
    console.error('[comp/grant]', { email, mintCode, error: err.message });
    res.status(500).json({ error: 'Failed to grant comp access' });
  }
});

module.exports = router;
