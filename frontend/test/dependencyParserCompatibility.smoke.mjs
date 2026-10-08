// Exercise the installed guarded fork through its real Tailwind/glob consumers.
// Pin is temporary until upstream braces publishes a fix for GHSA-vfj7-8cjw-p6xm.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import config from '../tailwind.config.js'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
for (const consumer of ['micromatch', 'chokidar']) {
  const load = createRequire(require.resolve(consumer))
  const braces = load('braces')
  assert.equal(load('braces/package.json').name, '@dieub/braces-depth-guard')
  assert.equal(load('braces/package.json').version, '3.0.3-pn.3')
  assert.deepEqual(braces.expand('src/**/*.{js,jsx}'), ['src/**/*.js', 'src/**/*.jsx'])
  assert.deepEqual(braces.expand('{a,{b,c}}/{01..03}'), ['a/01', 'a/02', 'a/03', 'b/01', 'b/02', 'b/03', 'c/01', 'c/02', 'c/03'])
  assert.deepEqual(braces.expand('file\\{x,y\\}'), ['file{x,y}'])
  assert.equal(braces.stringify(braces.parse('{a,b}')), '{a,b}')
  assert.equal(braces.compile('{a,b}'), '(a|b)')
  for (const [open, close] of [['{', '}'], ['(', ')']]) {
    const deep = open.repeat(101) + 'a' + close.repeat(101)
    for (const operation of ['parse', 'compile', 'expand']) {
      assert.throws(() => braces[operation](deep), /exceeds max depth/)
    }
  }
  // Public AST entry points must also reject depth independently of parsing.
  for (const operation of ['compile', 'expand', 'stringify']) {
    let ast = { type: 'text', value: 'a' }
    for (let n = 0; n < 102; n++) ast = { type: 'brace', nodes: [ast] }
    assert.throws(() => braces[operation]({ type: 'root', nodes: [ast] }), /exceeds max depth/)
  }
}
const glob = require('fast-glob')
const files = glob.sync(config.content, { cwd: root }).map(file => path.normalize(file))
assert.ok(files.includes('index.html'))
assert.ok(files.includes('src/App.jsx'))
assert.ok(files.some(file => file.endsWith('.js')))
const micromatch = require('micromatch')
assert.deepEqual(micromatch(['src/a.js', 'src/a.jsx', 'src/a.css'], 'src/*.{js,jsx}'), ['src/a.js', 'src/a.jsx'])
const workspace = require('find-yarn-workspace-root')
assert.equal(workspace(root), null)
const result = await postcss([tailwind({ ...config, content: [{ raw: '<div class="bg-accent text-text-muted dark:bg-bg-card hover:bg-accent-dim sm:grid-cols-2 p-4 w-[37px]"></div>' }] })])
  .process('@tailwind utilities;', { from: undefined })
for (const declaration of ['background-color: var(--accent)', 'color: var(--text-muted)', 'background-color: var(--bg-card)', 'background-color: var(--accent-dim)', 'grid-template-columns: repeat(2, minmax(0, 1fr))', 'padding: 1rem', 'width: 37px']) {
  assert.ok(result.css.includes(declaration), declaration)
}
assert.match(result.css, /@media \(min-width: 640px\)/)
assert.ok(result.css.includes('.dark'))
console.log('Dependency parser compatibility PASS: guarded recursion, brace/glob consumers, Tailwind 3 theme/dark/responsive/arbitrary utilities')
