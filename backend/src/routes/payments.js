const router = require('express').Router();
const Stripe = require('stripe');
const { dbGet, dbRun } = require('../db');
const auth = require('../middleware/auth');

function getStripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

function normalizePeriodEnd(unixTs) {
  return unixTs ? new Date(unixTs * 1000).toISOString() : null;
}

function isProStatus(status) {
  return status === 'active' || status === 'trialing';
}

async function updateUserFromSubscriptionEvent(subscription) {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id;
  const userId = subscription?.metadata?.user_id || null;
  const status = subscription?.status || 'free';
  const endsAt = normalizePeriodEnd(subscription?.current_period_end);
  const subscriptionId = subscription?.id || null;
  let updated = { changes: 0 };

  if (customerId) {
    updated = await dbRun(
      `UPDATE users
       SET stripe_customer_id = COALESCE(stripe_customer_id, ?),
           stripe_subscription_id = ?,
           subscription_status = ?,
           subscription_ends_at = ?,
           is_pro = ?
       WHERE stripe_customer_id = ?`,
      [customerId, subscriptionId, status, endsAt, isProStatus(status) ? 1 : 0, customerId]
    );
  }

  if (updated.changes === 0 && userId) {
    await dbRun(
      `UPDATE users
       SET stripe_customer_id = COALESCE(stripe_customer_id, ?),
           stripe_subscription_id = ?,
           subscription_status = ?,
           subscription_ends_at = ?,
           is_pro = ?
       WHERE id = ?`,
      [customerId || null, subscriptionId, status, endsAt, isProStatus(status) ? 1 : 0, userId]
    );
  }
}

// POST /api/payments/create-subscription-session
router.post('/create-subscription-session', auth, async (req, res) => {
  try {
    if (!process.env.STRIPE_PRICE_ID) {
      return res.status(500).json({ error: 'STRIPE_PRICE_ID is not configured' });
    }

    const stripe = getStripeClient();
    const user = await dbGet(
      `SELECT id, email, name, stripe_customer_id, stripe_subscription_id, subscription_status
       FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (isProStatus(user.subscription_status)) {
      return res.status(400).json({ error: 'An active subscription already exists' });
    }

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { user_id: user.id }
      });
      customerId = customer.id;
      await dbRun('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [customerId, user.id]);
    }

    const appUrl = process.env.APP_URL || process.env.CORS_ORIGIN?.split(',')[0] || 'http://localhost:5173';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${appUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/?checkout=cancel`,
      client_reference_id: user.id,
      subscription_data: {
        metadata: { user_id: user.id }
      }
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('[payments/create-subscription-session]', err.message);
    res.status(500).json({ error: 'Failed to create subscription session' });
  }
});

// POST /api/payments/webhook
router.post('/webhook', async (req, res) => {
  try {
    const stripe = getStripeClient();
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(500).json({ error: 'STRIPE_WEBHOOK_SECRET is not configured' });
    }

    const signature = req.headers['stripe-signature'];
    if (!signature) return res.status(400).json({ error: 'Missing Stripe signature' });

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    switch (event.type) {
      case 'customer.subscription.created': {
        await updateUserFromSubscriptionEvent(event.data.object);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
        const endsAt = normalizePeriodEnd(sub?.ended_at || sub?.current_period_end);
        await dbRun(
          `UPDATE users
           SET stripe_subscription_id = NULL,
               subscription_status = 'free',
               subscription_ends_at = ?,
               is_pro = 0
           WHERE stripe_subscription_id = ? OR stripe_customer_id = ?`,
          [endsAt, sub.id, customerId || null]
        );
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
        const subId = typeof invoice.subscription === 'string'
          ? invoice.subscription
          : invoice.subscription?.id;
        await dbRun(
          `UPDATE users
           SET stripe_subscription_id = COALESCE(?, stripe_subscription_id),
               subscription_status = 'past_due',
               is_pro = 0
           WHERE stripe_customer_id = ? OR stripe_subscription_id = ?`,
          [subId || null, customerId || null, subId || null]
        );
        break;
      }
      default:
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[payments/webhook]', err.message);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

// GET /api/payments/status
router.get('/status', auth, async (req, res) => {
  try {
    const user = await dbGet(
      `SELECT subscription_status, subscription_ends_at, stripe_customer_id, stripe_subscription_id
       FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      subscription_status: user.subscription_status || 'free',
      subscription_ends_at: user.subscription_ends_at || null,
      stripe_customer_id: user.stripe_customer_id || null,
      stripe_subscription_id: user.stripe_subscription_id || null
    });
  } catch (err) {
    console.error('[payments/status]', err.message);
    res.status(500).json({ error: 'Failed to get subscription status' });
  }
});

// POST /api/payments/cancel
router.post('/cancel', auth, async (req, res) => {
  try {
    const user = await dbGet(
      `SELECT stripe_subscription_id FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.stripe_subscription_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    const stripe = getStripeClient();
    const canceled = await stripe.subscriptions.cancel(user.stripe_subscription_id);
    await dbRun(
      `UPDATE users
       SET stripe_subscription_id = NULL,
           subscription_status = 'canceled',
           subscription_ends_at = ?,
           is_pro = 0
       WHERE id = ?`,
      [normalizePeriodEnd(canceled?.ended_at || canceled?.current_period_end), req.user.id]
    );

    res.json({
      ok: true,
      subscription_status: 'canceled',
      subscription_ends_at: normalizePeriodEnd(canceled?.ended_at || canceled?.current_period_end)
    });
  } catch (err) {
    console.error('[payments/cancel]', err.message);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

module.exports = router;
