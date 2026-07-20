import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  BETA_ACCESS_COPY,
  entitlementPresentation,
} from '../src/lib/entitlementPresentation.js'

const require = createRequire(import.meta.url)
const {
  DAILY_AI_LIMIT,
  FREE_MONTHLY_AI_LIMIT,
  aiUsageWindows,
  canUseAiFeedback,
  resolveEntitlement,
} = require('../../backend/src/lib/betaAccess')

let passed = 0
function check(condition, message) {
  assert.ok(condition, message)
  passed += 1
}

const paid = resolveEntitlement(
  { is_pro: 1, subscription_status: 'pro' },
  { betaEnabled: true }
)
check(paid.effectivePremiumAccess && paid.accessSource === 'subscription', 'paid subscription wins over beta')
check(paid.paidTier === 'pro' && paid.monthlyAiLimit === null, 'paid Pro tier and limits remain intact')

const agency = resolveEntitlement(
  { is_pro: 1, subscription_status: 'agency' },
  { betaEnabled: true }
)
check(agency.accessSource === 'subscription' && agency.paidTier === 'agency', 'paid Agency tier is preserved')

const beta = resolveEntitlement(
  { is_pro: 0, subscription_status: 'free' },
  { betaEnabled: true }
)
check(beta.effectivePremiumAccess && beta.accessSource === 'beta' && beta.paidTier === null, 'beta grant unlocks premium without claiming a paid tier')
check(beta.dailyAiLimit === DAILY_AI_LIMIT && beta.dailyAiLimit === 10, 'beta reports the enforced shared daily ceiling')
check(beta.monthlyAiLimit === null, 'beta does not report the free monthly cap as governing')

const free = resolveEntitlement(
  { is_pro: 0, subscription_status: 'free' },
  { betaEnabled: false }
)
check(!free.effectivePremiumAccess && free.accessSource === 'free' && free.paidTier === null, 'genuine free user remains free')
check(free.dailyAiLimit === DAILY_AI_LIMIT && free.monthlyAiLimit === FREE_MONTHLY_AI_LIMIT, 'free daily and monthly contracts remain unchanged')

check(canUseAiFeedback(beta, { dailyUsed: 9, monthlyUsed: 99 }), 'beta bypasses only the free monthly cap')
check(!canUseAiFeedback(beta, { dailyUsed: 10, monthlyUsed: 0 }), 'beta remains subject to the shared daily anti-abuse ceiling')
check(canUseAiFeedback(free, { dailyUsed: 4, monthlyUsed: 4 }), 'free user below both limits remains allowed')
check(!canUseAiFeedback(free, { dailyUsed: 4, monthlyUsed: 5 }), 'free monthly enforcement remains intact')

const windows = aiUsageWindows(new Date('2026-07-20T15:30:00.000Z'))
check(windows.dailyStart === '2026-07-20' && windows.dailyResetAt === '2026-07-21T00:00:00.000Z', 'daily usage reset metadata matches enforcement window')
check(windows.monthlyStart === '2026-07-01' && windows.monthlyResetAt === '2026-08-01T00:00:00.000Z', 'monthly usage reset metadata retains calendar-month meaning')

async function loadBetaAiUsagePayload() {
  const dbModulePath = require.resolve('../../backend/src/db')
  const authRoutePath = require.resolve('../../backend/src/routes/auth')
  const originalDbModule = require.cache[dbModulePath]
  const originalAuthRoute = require.cache[authRoutePath]
  const originalBetaAccess = process.env.FORGE_BETA_ACCESS
  let usageQueryIndex = 0

  try {
    require.cache[dbModulePath] = {
      id: dbModulePath,
      filename: dbModulePath,
      loaded: true,
      exports: {
        dbGet: async (sql) => {
          if (/FROM users WHERE id/.test(sql)) return { is_pro: 0, subscription_status: 'free' }
          if (/COUNT\(\*\) as cnt FROM ai_usage/.test(sql)) {
            const count = usageQueryIndex === 0 ? 7 : 12
            usageQueryIndex += 1
            return { cnt: count }
          }
          return null
        },
        dbAll: async () => [],
        dbRun: async () => ({ changes: 0 }),
        withTransaction: async (fn) => fn({}),
        withUserMutation: async (_userId, fn) => fn({}),
      },
    }
    delete require.cache[authRoutePath]
    process.env.FORGE_BETA_ACCESS = 'true'

    const router = require('../../backend/src/routes/auth')
    const route = router.stack.find((layer) => layer.route?.path === '/me/ai-usage' && layer.route.methods.get)
    const handler = route?.route?.stack?.at(-1)?.handle
    assert.equal(typeof handler, 'function', 'AI usage route handler is registered')

    let payload = null
    let statusCode = 200
    await handler(
      { user: { id: 'beta-user' } },
      {
        status(code) {
          statusCode = code
          return this
        },
        json(body) {
          payload = body
          return body
        },
      }
    )
    assert.equal(statusCode, 200)
    return payload
  } finally {
    if (originalDbModule) require.cache[dbModulePath] = originalDbModule
    else delete require.cache[dbModulePath]
    if (originalAuthRoute) require.cache[authRoutePath] = originalAuthRoute
    else delete require.cache[authRoutePath]
    if (originalBetaAccess === undefined) delete process.env.FORGE_BETA_ACCESS
    else process.env.FORGE_BETA_ACCESS = originalBetaAccess
  }
}

const betaUsagePayload = await loadBetaAiUsagePayload()
check(betaUsagePayload.effective_premium_access === true && betaUsagePayload.access_source === 'beta', 'beta AI usage payload reports effective premium access and beta source')
check(betaUsagePayload.daily.used === 7 && betaUsagePayload.daily.limit === 10, 'beta AI usage payload preserves the shared daily counter and ceiling')
check(betaUsagePayload.monthly.used === 12 && betaUsagePayload.monthly.limit === null, 'beta AI usage payload preserves the monthly counter without presenting the free cap')
check(Boolean(betaUsagePayload.daily.resets_at) && Boolean(betaUsagePayload.monthly.resets_at), 'AI usage payload retains explicit reset metadata')

const betaCopy = entitlementPresentation(beta)
const proCopy = entitlementPresentation(paid)
const agencyCopy = entitlementPresentation(agency)
const freeCopy = entitlementPresentation(free)
check(betaCopy.kind === 'beta' && betaCopy.title === BETA_ACCESS_COPY, 'frontend chooses exact beta copy for beta source')
check(proCopy.kind === 'subscription' && /Forged Hybrid Pro/.test(proCopy.title), 'frontend chooses paid Pro copy for a Pro subscription')
check(agencyCopy.kind === 'subscription' && /Forged Hybrid Agency/.test(agencyCopy.title), 'frontend chooses paid Agency copy for an Agency subscription')
check(freeCopy.kind === 'free' && /Free tier/.test(freeCopy.detail), 'frontend retains the genuine-free upgrade presentation')

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
const authRoute = read('backend/src/routes/auth.js')
const runsRoute = read('backend/src/routes/runs.js')
const workoutsRoute = read('backend/src/routes/workouts.js')
const premiumGate = read('backend/src/middleware/premiumGate.js')
const routesRoute = read('backend/src/routes/routes.js')
const proContext = read('frontend/src/context/ProContext.jsx')
const upgrade = read('frontend/src/pages/Upgrade.jsx')

check(/effective_premium_access:\s*entitlement\.effectivePremiumAccess/.test(authRoute) && /access_source:\s*entitlement\.accessSource/.test(authRoute), 'AI usage payload exposes effective access and source')
check(/monthly:[\s\S]*limit:\s*entitlement\.monthlyAiLimit/.test(authRoute) && /resets_at:\s*windows\.monthlyResetAt/.test(authRoute), 'AI usage payload uses canonical monthly limit and reset metadata')
check([runsRoute, workoutsRoute].every((source) => /canUseAiFeedback\(resolveEntitlement\(profile\)/.test(source)), 'run and workout feedback share canonical enforcement')
check([premiumGate, routesRoute].every((source) => /resolveEntitlement\(user\)\.effectivePremiumAccess/.test(source)), 'premium gates consume canonical entitlement access')
check(/api\.get\('\/auth\/me'\)/.test(proContext) && /entitlement\.accessSource/.test(proContext), 'frontend access context consumes canonical server entitlement')
check(/entitlementPresentation\(\{ accessSource, paidTier \}\)/.test(upgrade), 'upgrade page renders from explicit entitlement source and paid tier')

console.log(`ENTITLEMENT TRUTH SMOKE OK (${passed})`)
