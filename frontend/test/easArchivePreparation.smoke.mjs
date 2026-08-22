import assert from 'node:assert/strict'
import fs from 'node:fs'

const packageJson = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)

const lifecycleCommand = packageJson.scripts?.['eas-build-post-install']

assert.equal(
  lifecycleCommand,
  'npm run build && npx cap sync ios',
  'EAS post-install must fail closed after building Vite and synchronizing Capacitor iOS',
)

console.log('EAS ARCHIVE PREPARATION SMOKE OK')
