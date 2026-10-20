// Reproduce the missing-preview module failure without a listener or browser.
// Uses the actual harness include list and installed Vite optimizer, not mocks.
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig, optimizeDeps } from 'vite'
if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(import.meta.url)], { stdio: 'inherit' })
  assert.equal(result.signal, null)
  process.exit(result.status ?? 1)
}
const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const source = readFileSync(new URL('./activityShareStudioFramework.smoke.mjs', import.meta.url), 'utf8')
const include = [...source.match(/noDiscovery: true, include: \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map(match => match[1])
for (const dependency of ['react-leaflet', 'leaflet']) assert.ok(include.includes(dependency), `Harness must optimize ${dependency}`)
const oldLeaflet = new vm.SourceTextModule(readFileSync(require.resolve('leaflet'), 'utf8'))
const coreDom = readFileSync(join(dirname(require.resolve('@react-leaflet/core')), 'dom.js'), 'utf8')
assert.match(coreDom, /import \{ DomUtil \} from 'leaflet'/)
const importer = new vm.SourceTextModule(coreDom)
await assert.rejects(importer.link(() => oldLeaflet), /does not provide an export named 'DomUtil'/)
console.log('REPRODUCED unoptimized Leaflet: module linking fails before React mounts')
const scratch = mkdtempSync(join(tmpdir(), 'forge-share-modules-'))
try {
  const config = await resolveConfig({ root, configFile: false, envDir: join(scratch, 'no-env'), cacheDir: join(scratch, 'cache'),
    optimizeDeps: { noDiscovery: true, include } }, 'serve')
  const metadata = await optimizeDeps(config, true)
  assert.equal(metadata.optimized.leaflet.needsInterop, true, 'UMD needs Vite interop')
  assert.equal(metadata.optimized['react-leaflet'].needsInterop, false)
  const modules = new Map()
  const moduleAt = path => {
    if (!modules.has(path)) modules.set(path, new vm.SourceTextModule(readFileSync(path, 'utf8'), { identifier: path }))
    return modules.get(path)
  }
  const entry = moduleAt(metadata.optimized['react-leaflet'].file)
  await entry.link((specifier, referencing) => {
    assert.ok(specifier.startsWith('.'), `Unbundled dependency: ${specifier}`)
    return moduleAt(resolve(dirname(referencing.identifier), specifier))
  })
  assert.equal(entry.status, 'linked')
  console.log('PASS actual corrected Vite prebundle links React Leaflet and transitive imports; UI/browser still requires host gate')
} finally { rmSync(scratch, { recursive: true, force: true }) }
