import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const configURL = new URL('../playwright.config.mjs', import.meta.url).href
function readConfig(port) {
  const env = { ...process.env }
  delete env.FORGE_E2E_PORT
  if (port !== undefined) env.FORGE_E2E_PORT = port
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `import config from ${JSON.stringify(configURL)}; console.log(JSON.stringify(config))`,
  ], { env, encoding: 'utf8', timeout: 10_000 })
}

for (const [value, expected] of [[undefined, 5197], ['5297', 5297], ['1', 1], ['65535', 65535]]) {
  const result = readConfig(value)
  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(result.stdout)
  assert.equal(config.use.baseURL, `http://127.0.0.1:${expected}`)
  assert.equal(config.webServer.url, config.use.baseURL)
  assert.equal(config.webServer.command, `npm run build && npm run preview -- --host 127.0.0.1 --port ${expected} --strictPort`)
  assert.equal(config.webServer.reuseExistingServer, false)
  assert.equal(config.webServer.timeout, 120_000)
}

for (const value of ['', '0', '65536', '999999999999999999', '-1', '+5297', '05297',
  ' 5297', '5297 ', '5297\n', '5297.0', '5e3', '0x14b1', 'NaN', 'Infinity',
  '5297; echo unsafe', '$(echo 5297)', '`echo 5297`']) {
  const result = readConfig(value)
  assert.equal(result.status, 1, `invalid port ${JSON.stringify(value)}: ${result.stderr}`)
  assert.match(result.stderr, /FORGE_E2E_PORT must be an integer TCP port/)
  assert.equal(result.stdout, '')
}

console.log('PLAYWRIGHT CONFIG OK: default, override, boundaries, 18 invalid inputs, strict port, no server reuse')
