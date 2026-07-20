export const BETA_ACCESS_COPY = 'Beta access active — all Pro features are unlocked during beta.'

export function entitlementPresentation({ accessSource, paidTier } = {}) {
  if (accessSource === 'beta') {
    return {
      kind: 'beta',
      title: BETA_ACCESS_COPY,
      detail: 'Apple Health sync and premium insights are unlocked for the beta period.',
    }
  }

  if (accessSource === 'subscription') {
    const tierName = paidTier === 'agency' ? 'Agency' : 'Pro'
    return {
      kind: 'subscription',
      title: `You are on Forged Hybrid ${tierName}`,
      detail: 'Apple Health sync and premium insights are unlocked.',
    }
  }

  return {
    kind: 'free',
    title: 'Forged Hybrid Subscription',
    detail: 'Free tier supports basic workout logging. Pro unlocks Apple Health sync and premium insights.',
  }
}
