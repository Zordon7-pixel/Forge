import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const indexPath = path.join(frontendRoot, 'dist/index.html')
const html = fs.readFileSync(indexPath, 'utf8')
const assetPath = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1]

if (!assetPath || !/^\/assets\/[A-Za-z0-9_.-]+\.js$/.test(assetPath)) {
  throw new Error(`Unable to resolve the built Vite entry from ${indexPath}`)
}

console.log(`FORGE_QA_EXPECTED_ASSET=${assetPath}`)
