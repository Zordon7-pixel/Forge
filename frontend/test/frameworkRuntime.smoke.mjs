import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(here, '..')
const repoRoot = path.resolve(frontendRoot, '..')
const frontendPackage = JSON.parse(fs.readFileSync(path.join(frontendRoot, 'package.json'), 'utf8'))
const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

let passed = 0

function check(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(target) : [target]
  })
}

const dependencies = frontendPackage.dependencies || {}
const sourceFiles = walk(path.join(frontendRoot, 'src')).filter((file) => /\.(?:js|jsx|mjs)$/.test(file))
const staleRouterImports = sourceFiles.filter((file) => fs.readFileSync(file, 'utf8').includes('react-router-dom'))

check(dependencies.react === '^19.2.7', 'React must stay on the Router v8-compatible baseline')
check(dependencies['react-dom'] === '^19.2.7', 'React DOM must match the React baseline')
check(dependencies['react-router'] === '^8.3.0', 'React Router must include the RSC CSRF fix')
check(!dependencies['react-router-dom'], 'React Router v8 no longer publishes react-router-dom')
check(dependencies['react-leaflet'] === '^5.0.0', 'React Leaflet must support React 19')
check(frontendPackage.engines?.node === '>=22.22.0', 'Frontend Node baseline must satisfy React Router v8')
check(rootPackage.engines?.node === '>=22.22.0', 'Railway Node baseline must satisfy React Router v8')
check(staleRouterImports.length === 0, `Stale react-router-dom imports: ${staleRouterImports.join(', ')}`)

console.log(`FRAMEWORK RUNTIME SMOKE OK (${passed})`)
