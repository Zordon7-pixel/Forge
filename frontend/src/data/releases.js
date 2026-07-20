export const RELEASE_CTA_ALLOWLIST = Object.freeze([
  '/community',
  '/plan',
  '/run',
  '/log-lift',
  '/health',
  '/history',
  '/gear',
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
  Object.freeze({
    id: 'forged-closet',
    sequence: 2,
    publishedAt: '2026-07-16',
    titleKey: 'whatsNew.releases.forgedCloset.title',
    summaryKey: 'whatsNew.releases.forgedCloset.summary',
    highlightKeys: Object.freeze([
      'whatsNew.releases.forgedCloset.catalog',
      'whatsNew.releases.forgedCloset.rotation',
      'whatsNew.releases.forgedCloset.pick',
    ]),
    cta: Object.freeze({
      labelKey: 'whatsNew.releases.forgedCloset.cta',
      to: '/gear',
    }),
    delivery: 'web',
    minIosBuild: null,
    minAndroidBuild: null,
    audience: 'all',
  }),
  Object.freeze({
    id: 'share-the-work',
    sequence: 3,
    publishedAt: '2026-07-20',
    titleKey: 'whatsNew.releases.shareTheWork.title',
    summaryKey: 'whatsNew.releases.shareTheWork.summary',
    highlightKeys: Object.freeze([
      'whatsNew.releases.shareTheWork.cards',
      'whatsNew.releases.shareTheWork.races',
      'whatsNew.releases.shareTheWork.sync',
    ]),
    cta: Object.freeze({
      labelKey: 'whatsNew.releases.shareTheWork.cta',
      to: '/history',
    }),
    delivery: 'web',
    minIosBuild: null,
    minAndroidBuild: null,
    audience: 'all',
  }),
  Object.freeze({
    id: 'cleaner-training-signals',
    sequence: 4,
    publishedAt: '2026-07-20',
    titleKey: 'whatsNew.releases.cleanerTrainingSignals.title',
    summaryKey: 'whatsNew.releases.cleanerTrainingSignals.summary',
    highlightKeys: Object.freeze([
      'whatsNew.releases.cleanerTrainingSignals.organization',
      'whatsNew.releases.cleanerTrainingSignals.zones',
      'whatsNew.releases.cleanerTrainingSignals.alerts',
    ]),
    cta: Object.freeze({
      labelKey: 'whatsNew.releases.cleanerTrainingSignals.cta',
      to: '/history',
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
