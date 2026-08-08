const { readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const testDir = path.join(root, 'test');
const files = readdirSync(testDir)
  .filter((file) => file.endsWith('.smoke.js'))
  .sort();

for (const file of files) {
  const argumentSets = file === 'racePlanQuality.smoke.js'
    ? [[], ['--semantic-acceptance']]
    : [[]];
  for (const args of argumentSets) {
    console.log(`\n[backend smoke] ${file}${args.length ? ' --semantic-acceptance' : ''}`);
    const result = spawnSync(process.execPath, [path.join(testDir, file), ...args], {
      cwd: root,
      stdio: 'inherit',
    });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}

console.log(`\nBACKEND SMOKE SUITE OK (${files.length} files)`);
