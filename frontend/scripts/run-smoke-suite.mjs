import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testDir = path.join(root, 'test')
const files = readdirSync(testDir)
  .filter((file) => file.endsWith('.smoke.mjs'))
  .sort()

for (const file of files) {
  console.log(`\n[frontend smoke] ${file}`)
  const result = spawnSync(process.execPath, [path.join(testDir, file)], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status || 1)
}

console.log(`\nFRONTEND SMOKE SUITE OK (${files.length} files)`)
