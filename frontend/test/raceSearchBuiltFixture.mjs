// Test-only production bundle: no dev optimizer, source-file server, env files,
// disk output or dependency changes. The same bytes are linked and browser-served.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer, request } from 'node:http'
import path from 'node:path'
import { readFileSync } from 'node:fs'

export function linkChunks(chunks) {
  // Parse/link EVERY emitted chunk, including dynamic branches, without running
  // browser code. Native ESM linking catches missing default/named/star exports.
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `
    import { SourceTextModule } from 'node:vm';
    import { readFileSync } from 'node:fs';
    const chunks = JSON.parse(readFileSync(0, 'utf8'));
    const modules = new Map(chunks.map(({fileName, code}) => [new URL(fileName, 'https://fixture.invalid/').href, new SourceTextModule(code, {identifier: new URL(fileName, 'https://fixture.invalid/').href})]));
    for (const mod of modules.values()) if (mod.status === 'unlinked') await mod.link((specifier, parent) => {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new Error('Nonlocal module: ' + specifier);
      const child = modules.get(new URL(specifier, parent.identifier).href);
      if (!child) throw new Error('Missing bundled module: ' + specifier);
      return child;
    });
    if ([...modules.values()].some(mod => mod.status !== 'linked')) throw new Error('Incomplete module graph');
    console.log('PASS linked ' + modules.size + ' complete output modules (no evaluation)');
  `], { input: JSON.stringify(chunks), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.status, 0, `Full fixture module link failed:\n${result.stderr || result.error?.message}`)
  return result.stdout.trim()
}

export async function buildFixture(root, entry, mode) {
  const { build } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
  const id = path.join(root, 'race-qa.jsx')
  // Nonexistent isolated envDir: nothing created outside the approved scratch.
  // envPrefix also excludes inherited VITE_* variables from these local assets.
  const isolated = path.join('/Users/zordon/.hermes/cache/scratch', `race-bundle-${randomUUID()}`)
  let moduleGraph
  const result = await build({
    root, configFile: false, envDir: isolated, envPrefix: 'RACE_QA_UNUSED_', publicDir: path.join(root, 'public'),
    cacheDir: path.join(isolated, 'cache'),
    plugins: [react(), { name: 'race-qa-built-entry',
      resolveId(source) { if (source === '/race-qa.jsx') return id },
      load(source) { if (source === id) return entry },
      generateBundle() {
        moduleGraph = [...this.getModuleIds()].map(id => {
          const info = this.getModuleInfo(id)
          return { id, imports: info.importedIds, dynamicImports: info.dynamicallyImportedIds, external: info.isExternal }
        })
      },
    }],
    build: { write: false, minify: false, rollupOptions: {
      input: '/race-qa.jsx',
      onwarn(warning, warn) {
        if (['UNRESOLVED_IMPORT', 'MISSING_EXPORT'].includes(warning.code)) throw new Error(warning.message)
        warn(warning)
      },
    } },
  })
  const chunks = result.output.filter(item => item.type === 'chunk')
  const sources = [...new Set(chunks.flatMap(chunk => Object.keys(chunk.modules)))].sort()
  for (const component of ['pages/PlanCatalog.jsx', 'pages/Upgrade.jsx', 'context/ProContext.jsx', 'components/PlanCandidateDecisionSheet.jsx', 'components/hyrox/HyroxPlanSetup.jsx']) {
    assert.ok(sources.includes(path.join(root, 'src', component)), `real transitive component bundled: ${component}`)
  }
  const files = new Map(result.output.map(item => ['/' + item.fileName, item.type === 'chunk' ? item.code : item.source]))
  // Public assets are not copied by write:false. Admit only the existing CSS icon.
  files.set('/icon-192.png', readFileSync(path.join(root, 'public/icon-192.png')))
  for (const chunk of chunks) for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) {
    assert.ok(files.has('/' + dependency), `no external/missing chunk: ${dependency}`)
  }
  const linkResult = linkChunks(chunks.map(({fileName, code}) => ({fileName, code})))
  const entries = chunks.filter(chunk => chunk.isEntry)
  assert.equal(entries.length, 1)
  const css = result.output.filter(item => item.fileName.endsWith('.css'))
  assert.ok(css.length > 0, 'actual application CSS bundled')
  const html = '<html><head><meta name="viewport" content="width=device-width, initial-scale=1">'
    + css.map(item => `<link rel="stylesheet" href="/${item.fileName}">`).join('')
    + '</head><body><p>SYNTHETIC LOCAL QA — ' + mode
    + '</p><main id="root" style="padding:12px;max-width:760px;margin:auto"></main>'
    + `<script type="module" src="/${entries[0].fileName}"></script></body></html>`
  for (const route of ['/plan-catalog', '/upgrade', '/plan']) files.set(route, html)
  return { files, linkResult, graph: { sources, moduleGraph, chunks: chunks.map(({fileName, imports, dynamicImports}) => ({fileName, imports, dynamicImports})),
    sha256: Object.fromEntries([...files].map(([file, value]) => [file, createHash('sha256').update(value).digest('hex')])) } }
}

export function fixtureResponse(files, url, method = 'GET') {
  // Exact asset allowlist: no /@fs, source traversal, directory listing or SPA
  // fallback exposing arbitrary files. Only this build's bytes can be served.
  if (!['GET', 'HEAD'].includes(method) || !files.has(url)) return { status: 404, body: 'Not found', type: 'text/plain' }
  const type = url.endsWith('.js') ? 'text/javascript' : url.endsWith('.css') ? 'text/css' : url.endsWith('.png') ? 'image/png' : ['/plan-catalog', '/upgrade', '/plan'].includes(url) ? 'text/html' : 'application/octet-stream'
  return { status: 200, body: method === 'HEAD' ? '' : files.get(url), type }
}

export async function serveFixture(files, backend) {
  if (backend) assert.match(backend, /^http:\/\/127\.0\.0\.1:\d+$/, 'proxy only the owned local backend')
  const server = createServer((req, res) => {
    if (backend && req.url.startsWith('/api/')) {
      const upstream = request(backend + req.url, { method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res)
      })
      upstream.on('error', error => { console.error('Local QA proxy failed:', error.message); res.writeHead(502); res.end('Local backend unavailable') })
      req.on('aborted', () => upstream.destroy())
      req.pipe(upstream)
      return
    }
    const response = fixtureResponse(files, req.url, req.method)
    res.writeHead(response.status, { 'Content-Type': response.type, 'Cache-Control': 'no-store' })
    res.end(response.body)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

export function fixtureNegativeControls(files) {
  for (const url of ['/@fs/etc/passwd', '/src/pages/PlanCatalog.jsx', '/../package.json', '/node_modules/react/index.js', '/unknown', '/plan-catalog?file=../../.env']) {
    assert.equal(fixtureResponse(files, url).status, 404, 'strict static allowlist: ' + url)
  }
  for (const [url, body] of files) {
    assert.equal(fixtureResponse(files, url).status, 200, 'every emitted asset is served')
    assert.equal(fixtureResponse(files, url).body, body, 'exact linked bytes are served')
  }
  assert.equal(fixtureResponse(files, '/icon-192.png').type, 'image/png')
  assert.equal(fixtureResponse(files, '/plan-catalog', 'POST').status, 404)
  assert.equal(fixtureResponse(files, '/plan-catalog', 'HEAD').body, '')
  assert.equal(fixtureResponse(files, '/plan-catalog').body, files.get('/plan-catalog'))
  assert.throws(() => linkChunks([
    { fileName: 'entry.js', code: "import value from './star.js'; export {value}" },
    { fileName: 'star.js', code: "export * from './leaf.js'" },
    { fileName: 'leaf.js', code: 'export default 1' },
  ]), /does not provide an export named 'default'/)
  assert.throws(() => linkChunks([{ fileName: 'entry.js', code: "import './missing.js'" }]), /Missing bundled module/)
  assert.throws(() => linkChunks([{ fileName: 'entry.js', code: "import 'https:\/\/example.invalid\/remote.js'" }]), /Nonlocal module/)
  return 'PASS missing default/star export, missing chunk, external import and filesystem denial controls'
}
