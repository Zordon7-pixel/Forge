#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appJsonPath = process.env.FORGE_APP_JSON || resolve(repo, 'frontend/app.json')
const infoPlistPath = process.env.FORGE_INFO_PLIST || resolve(repo, 'frontend/ios/App/App/Info.plist')
const app = JSON.parse(readFileSync(appJsonPath, 'utf8'))
const configuredValues = app?.expo?.ios?.infoPlist || {}

const syncedKeys = [
  'NSHealthShareUsageDescription',
  'NSHealthUpdateUsageDescription',
  'NSContactsUsageDescription',
]

const nativeOnlyKeys = [
  'NSLocationWhenInUseUsageDescription',
  'NSLocationAlwaysAndWhenInUseUsageDescription',
]

function plistValue(key) {
  try {
    return execFileSync('/usr/bin/plutil', [
      '-extract', key, 'raw', '-o', '-', infoPlistPath,
    ], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error(`Missing ${key} in native Info.plist`)
  }
}

function assertPurpose(key, value, source) {
  if (typeof value !== 'string' || value.trim().length < 20) {
    throw new Error(`${key} in ${source} must contain a specific user-facing purpose string`)
  }
}

execFileSync('/usr/bin/plutil', ['-lint', infoPlistPath], { stdio: 'ignore' })

for (const key of syncedKeys) {
  const configured = configuredValues[key]
  const native = plistValue(key)
  assertPurpose(key, configured, 'app.json')
  assertPurpose(key, native, 'native Info.plist')
  if (configured.trim() !== native) {
    throw new Error(`${key} differs between app.json and native Info.plist`)
  }
}

for (const key of nativeOnlyKeys) {
  assertPurpose(key, plistValue(key), 'native Info.plist')
}

console.log(`iOS privacy metadata OK: ${syncedKeys.length + nativeOnlyKeys.length} purpose strings verified`)
