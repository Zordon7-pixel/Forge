export const RELEASE_CTA_ALLOWLIST = Object.freeze([
  '/community',
  '/plan',
  '/run',
  '/log-lift',
  '/health',
  '/history',
  '/more',
])

export const RELEASES = Object.freeze([
  Object.freeze({
    id: 'private-training-together',
    sequence: 1,
    publishedAt: '2026-07-15',
    titleKey: 'whatsNew.releases.privateTraining.title',
    summaryKey: 'whatsNew.releases.privateTraining.summary',
    highlightKeys: Object.freeze([
      'whatsNew.releases.privateTraining.friends',
      'whatsNew.releases.privateTraining.challenges',
      'whatsNew.releases.privateTraining.groupRuns',
    ]),
    cta: Object.freeze({
      labelKey: 'whatsNew.releases.privateTraining.cta',
      to: '/community?tab=runs',
    }),
    delivery: 'web',
    minIosBuild: null,
    minAndroidBuild: null,
    audience: 'all',
  }),
])

export function isAllowedReleaseCta(path = '') {
  const pathname = String(path).split('?')[0]
  return RELEASE_CTA_ALLOWLIST.includes(pathname)
}

export function eligibleReleases(runtime = {}) {
  const platform = runtime.platform || 'web'
  const build = Number(runtime.build || 0)
  return RELEASES.filter((release) => {
    if (release.audience !== 'all' && release.audience !== platform) return false
    if (release.delivery === 'web') return true
    if (platform === 'ios') return Number.isInteger(build) && build >= Number(release.minIosBuild || Infinity)
    if (platform === 'android') return Number.isInteger(build) && build >= Number(release.minAndroidBuild || Infinity)
    return false
  })
}

export function newestEligibleRelease(runtime = {}) {
  return eligibleReleases(runtime).at(-1) || null
}
