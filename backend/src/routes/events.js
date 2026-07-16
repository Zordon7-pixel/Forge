const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const auth = require('../middleware/auth');
const { dbRun } = require('../db');

const ALLOWED_EVENTS = new Set([
  'app_open',
  'checkin',
  'run_logged',
  'lift_logged',
  'today_card_viewed',
  'recommendation_followed',
  'whats_new_shown',
  'whats_new_opened',
  'whats_new_cta',
]);

const BLOCKED_PROP_KEY = /(email|name|token|secret|password|authorization|auth|jwt|session|phone|address)/i;
const ALLOWED_PROP_KEYS = new Set([
  'action',
  'card',
  'category',
  'count',
  'distance_bucket',
  'duration_bucket',
  'lift_type',
  'mode',
  'plan_type',
  'platform',
  'recommendation_type',
  'run_type',
  'screen',
  'source',
  'surface',
  'type',
  'unit',
  'value',
  'via',
  'workout_type',
]);
const MAX_PROPS = 12;
const MAX_KEY_LENGTH = 40;
const MAX_STRING_LENGTH = 120;

function sanitizeProps(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const clean = {};
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(clean).length >= MAX_PROPS) break;
    if (
      typeof key !== 'string' ||
      key.length === 0 ||
      key.length > MAX_KEY_LENGTH ||
      !ALLOWED_PROP_KEYS.has(key) ||
      BLOCKED_PROP_KEY.test(key)
    ) {
      continue;
    }

    if (value === null || typeof value === 'boolean') {
      clean[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      clean[key] = value;
    } else if (typeof value === 'string') {
      clean[key] = value.slice(0, MAX_STRING_LENGTH);
    }
  }

  return Object.keys(clean).length ? clean : null;
}

router.post('/', auth, async (req, res) => {
  const { event_name: eventName, eventName: camelEventName, props } = req.body || {};
  const normalizedEventName = eventName || camelEventName;

  if (!ALLOWED_EVENTS.has(normalizedEventName)) {
    return res.status(400).json({ error: 'Unknown event_name' });
  }

  try {
    const safeProps = sanitizeProps(props);
    await dbRun(
      `INSERT INTO events (id, user_id, event_name, props)
       VALUES (?, ?, ?, ?::jsonb)`,
      [
        uuidv4(),
        req.user.id,
        normalizedEventName,
        safeProps ? JSON.stringify(safeProps) : null,
      ]
    );
  } catch (err) {
    console.error('[events] Failed to store usage event:', {
      userId: req.user?.id,
      eventName: normalizedEventName,
      error: err.message,
    });
  }

  return res.status(204).end();
});

module.exports = router;
