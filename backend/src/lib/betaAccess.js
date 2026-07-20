function betaAccessEnabled() {
  return String(process.env.FORGE_BETA_ACCESS || '').trim().toLowerCase() === 'true';
}

const DAILY_AI_LIMIT = 10;
const FREE_MONTHLY_AI_LIMIT = 5;
const PREMIUM_STATUSES = new Set(['pro', 'active', 'trialing', 'agency', 'comp']);

function normalizedStatus(user) {
  return String(user?.subscription_status || '').trim().toLowerCase();
}

function paidTierFor(user) {
  const declaredTier = String(user?.paid_tier || user?.subscription_tier || '').trim().toLowerCase();
  if (declaredTier === 'agency' || normalizedStatus(user) === 'agency') return 'agency';
  return 'pro';
}

function hasPersistedPremiumAccess(user) {
  return user?.is_pro === true
    || Number(user?.is_pro || 0) === 1
    || PREMIUM_STATUSES.has(normalizedStatus(user));
}

function resolveEntitlement(user, { betaEnabled = betaAccessEnabled() } = {}) {
  if (hasPersistedPremiumAccess(user)) {
    return {
      effectivePremiumAccess: true,
      accessSource: 'subscription',
      paidTier: paidTierFor(user),
      dailyAiLimit: DAILY_AI_LIMIT,
      monthlyAiLimit: null,
    };
  }

  if (betaEnabled) {
    return {
      effectivePremiumAccess: true,
      accessSource: 'beta',
      paidTier: null,
      dailyAiLimit: DAILY_AI_LIMIT,
      monthlyAiLimit: null,
    };
  }

  return {
    effectivePremiumAccess: false,
    accessSource: 'free',
    paidTier: null,
    dailyAiLimit: DAILY_AI_LIMIT,
    monthlyAiLimit: FREE_MONTHLY_AI_LIMIT,
  };
}

function canUseAiFeedback(entitlement, { dailyUsed = 0, monthlyUsed = 0 } = {}) {
  const dailyAllowed = entitlement.dailyAiLimit === null
    || Number(dailyUsed || 0) < entitlement.dailyAiLimit;
  const monthlyAllowed = entitlement.monthlyAiLimit === null
    || Number(monthlyUsed || 0) < entitlement.monthlyAiLimit;
  return dailyAllowed && monthlyAllowed;
}

function aiUsageWindows(now = new Date()) {
  const current = Number.isNaN(now.getTime()) ? new Date() : now;
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth();
  const day = current.getUTCDate();
  return {
    dailyStart: new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10),
    dailyResetAt: new Date(Date.UTC(year, month, day + 1)).toISOString(),
    monthlyStart: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10),
    monthlyResetAt: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
  };
}

module.exports = {
  DAILY_AI_LIMIT,
  FREE_MONTHLY_AI_LIMIT,
  aiUsageWindows,
  betaAccessEnabled,
  canUseAiFeedback,
  resolveEntitlement,
};
