import assert from 'node:assert/strict'
import fs from 'node:fs'

const packageJson = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)
const easJson = JSON.parse(
  fs.readFileSync(new URL('../eas.json', import.meta.url), 'utf8'),
)

const lifecycleCommand = packageJson.scripts?.['eas-build-post-install']
const nodeEngine = packageJson.engines?.node
const minimumNodeMatch = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(nodeEngine ?? '')

assert.equal(
  lifecycleCommand,
  'npm run build && npx cap sync ios',
  'EAS post-install must fail closed after building Vite and synchronizing Capacitor iOS',
)

assert.ok(
  minimumNodeMatch,
  `The archive smoke requires an exact >=x.y.z Node engine, received ${JSON.stringify(nodeEngine)}`,
)

const minimumNode = minimumNodeMatch.slice(1).map(Number)
const satisfiesNodeEngine = (version) => {
  if (typeof version !== 'string') return false

  const versionMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!versionMatch) return false

  const pinnedNode = versionMatch.slice(1).map(Number)
  for (let index = 0; index < minimumNode.length; index += 1) {
    if (pinnedNode[index] !== minimumNode[index]) {
      return pinnedNode[index] > minimumNode[index]
    }
  }
  return true
}

const buildProfiles = Object.entries(easJson.build ?? {})
assert.ok(buildProfiles.length > 0, 'eas.json must define at least one build profile')
for (const requiredProfile of ['preview', 'production']) {
  assert.ok(
    Object.hasOwn(easJson.build, requiredProfile),
    `eas.json must retain the ${requiredProfile} build profile`,
  )
}

for (const [profileName, profile] of buildProfiles) {
  assert.ok(
    satisfiesNodeEngine(profile?.node),
    `EAS iOS build profile "${profileName}" must pin a profile-level Node runtime satisfying ${nodeEngine}; received ${JSON.stringify(profile?.node)}`,
  )
}

console.log('EAS ARCHIVE PREPARATION SMOKE OK')
