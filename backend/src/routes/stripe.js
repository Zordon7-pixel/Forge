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

function toIsoFromUnix(unixTs) {
  return unixTs ? new Date(unixTs * 1000).toISOString() : null;
}

function resolvePriceId(plan) {
  if (plan === 'annual') return process.env.STRIPE_ANNUAL_PRICE_ID || process.env.STRIPE_PRICE_ID;
  return process.env.STRIPE_MONTHLY_PRICE_ID || process.env.STRIPE_PRICE_ID;
}

function toSubscriptionStatus(stripeStatus, eventType) {
  const normalized = String(stripeStatus || '').toLowerCase();
  if (eventType === 'customer.subscription.deleted') return 'cancelled';
  if (eventType === 'invoice.paid') return 'pro';
  if (normalized === 'active' || normalized === 'trialing') return 'pro';
  if (normalized === 'canceled' || normalized === 'unpaid' || normalized === 'past_due') return 'cancelled';
  return 'free';
}

async function upsertCustomerId(user, stripe) {
  if (user.stripe_customer_id) return user.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: { user_id: user.id },
  });

  await dbRun('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [customer.id, user.id]);
  return customer.id;
}

async function applyStatusFromEvent({ customerId, subscriptionId, status, periodEnd }) {
  await dbRun(
    `UPDATE users
     SET stripe_subscription_id = COALESCE(?, stripe_subscription_id),
         subscription_status = ?,
         subscription_ends_at = ?,
         is_pro = ?
     WHERE stripe_customer_id = ? OR stripe_subscription_id = ?`,
    [
      subscriptionId || null,
      status,
      periodEnd || null,
      status === 'pro' ? 1 : 0,
      customerId || null,
      subscriptionId || null,
    ]
  );
}

// POST /api/stripe/create-subscription
router.post('/create-subscription', auth, async (req, res) => {
  try {
    const { plan = 'monthly', usePaymentSheet = false } = req.body || {};
    const priceId = resolvePriceId(plan);
    if (!priceId) {
      return res.status(500).json({ error: 'Stripe price id is not configured' });
    }

    const stripe = getStripeClient();
    const user = await dbGet(
      `SELECT id, email, name, stripe_customer_id, stripe_subscription_id, subscription_status
       FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (String(user.subscription_status || '').toLowerCase() === 'pro') {
      return res.status(400).json({ error: 'User already has a Pro subscription' });
    }

    const customerId = await upsertCustomerId(user, stripe);

    if (usePaymentSheet) {
      const ephemeralKey = await stripe.ephemeralKeys.create(
        { customer: customerId },
        { apiVersion: '2024-06-20' }
      );

      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        expand: ['latest_invoice.payment_intent'],
        metadata: {
          user_id: user.id,
          plan: String(plan || 'monthly'),
        },
      });

      const clientSecret = subscription?.latest_invoice?.payment_intent?.client_secret;
      if (!clientSecret) {
        return res.status(500).json({ error: 'Failed to initialize subscription payment' });
      }

      await dbRun(
        `UPDATE users
         SET stripe_subscription_id = ?, subscription_status = 'free', is_pro = 0
         WHERE id = ?`,
        [subscription.id, user.id]
      );

      return res.json({
        paymentSheet: {
          subscriptionId: subscription.id,
          customerId,
          customerEphemeralKeySecret: ephemeralKey.secret,
          paymentIntentClientSecret: clientSecret,
        },
      });
    }

    const appUrl = process.env.APP_URL || process.env.CORS_ORIGIN?.split(',')[0] || 'http://localhost:5173';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/upgrade?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/upgrade?checkout=cancel`,
      client_reference_id: user.id,
      subscription_data: {
        metadata: {
          user_id: user.id,
          plan: String(plan || 'monthly'),
        },
      },
    });

    return res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('[stripe/create-subscription]', err.message);
    return res.status(500).json({ error: 'Unable to create subscription' });
  }
});

// POST /api/stripe/webhook
router.post('/webhook', async (req, res) => {
  try {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(500).json({ error: 'STRIPE_WEBHOOK_SECRET is not configured' });
    }

    const stripe = getStripeClient();
    const signature = req.headers['stripe-signature'];
    if (!signature) return res.status(400).json({ error: 'Missing Stripe signature' });

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      const nextStatus = toSubscriptionStatus(sub.status, event.type);
      await applyStatusFromEvent({
        customerId,
        subscriptionId: sub.id,
        status: nextStatus,
        periodEnd: toIsoFromUnix(sub.current_period_end || sub.ended_at),
      });
    }

    if (event.type === 'invoice.paid') {
      const invoice = event.data.object;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      const subId = typeof invoice.subscription === 'string'
        ? invoice.subscription
        : invoice.subscription?.id;

      await applyStatusFromEvent({
        customerId,
        subscriptionId: subId,
        status: toSubscriptionStatus('active', 'invoice.paid'),
        periodEnd: toIsoFromUnix(invoice.period_end),
      });
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('[stripe/webhook]', err.message);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
});

router.get('/status', auth, async (req, res) => {
  try {
    const user = await dbGet(
      `SELECT subscription_status, stripe_customer_id, stripe_subscription_id, is_pro
       FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    const normalized = String(user.subscription_status || '').toLowerCase();
    const status = (normalized === 'active' || normalized === 'trialing') ? 'pro' : (normalized || 'free');

    return res.json({
      subscription_status: status,
      is_pro: Number(user.is_pro || 0),
      stripe_customer_id: user.stripe_customer_id || null,
      stripe_subscription_id: user.stripe_subscription_id || null,
    });
  } catch (err) {
    console.error('[stripe/status]', err.message);
    return res.status(500).json({ error: 'Failed to load subscription status' });
  }
});

module.exports = router;
