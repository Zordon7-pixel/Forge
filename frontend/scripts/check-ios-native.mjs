import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const iosRoot = path.join(root, 'ios/App')
const appDir = path.join(iosRoot, 'App')

const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')
const appJson = JSON.parse(read('app.json')).expo
const capacitorConfig = read('capacitor.config.ts')
const project = read('ios/App/App.xcodeproj/project.pbxproj')
const viewController = read('ios/App/App/AppViewController.swift')
const infoPlist = read('ios/App/App/Info.plist')
const entitlements = read('ios/App/App/App.entitlements')
const packageSwift = read('ios/App/CapApp-SPM/Package.swift')

let assertions = 0
function check(condition, message) {
  assert.ok(condition, message)
  assertions += 1
}

function plistString(source, key) {
  return source.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1]?.trim() || ''
}

const configAppId = capacitorConfig.match(/appId:\s*'([^']+)'/)?.[1]
const configAppName = capacitorConfig.match(/appName:\s*'([^']+)'/)?.[1]
const configServerUrl = capacitorConfig.match(/url:\s*'([^']+)'/)?.[1]

check(configAppId === appJson.ios.bundleIdentifier, 'Capacitor and EAS use the same iOS bundle identifier')
check(configAppName === appJson.name, 'Capacitor and EAS use the same visible app name')
check(configServerUrl === 'https://forge-production-773f.up.railway.app', 'native shell loads the intended production origin')
check(plistString(infoPlist, 'CFBundleDisplayName') === appJson.name, 'Info.plist display name matches app.json')

const projectBundleIds = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((match) => match[1])
check(projectBundleIds.includes(appJson.ios.bundleIdentifier), 'Xcode app target uses the EAS bundle identifier')
check(projectBundleIds.includes(`${appJson.ios.bundleIdentifier}.runactivity`), 'Live Activity target is namespaced under the app bundle')

const projectBuildNumbers = new Set(
  [...project.matchAll(/CURRENT_PROJECT_VERSION = ([0-9]+);/g)].map((match) => match[1])
)
check(projectBuildNumbers.size === 1 && projectBuildNumbers.has(appJson.ios.buildNumber), 'all Xcode targets match app.json buildNumber')

const projectVersions = new Set(
  [...project.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((match) => match[1])
)
check(projectVersions.size === 1 && projectVersions.has(appJson.version), 'all Xcode targets match app.json version')

const plugins = [
  'ForgeHealthPlugin',
  'ForgeWatchWorkoutPlugin',
  'ForgeContactsPlugin',
  'ForgeNotificationPlugin',
  'ForgePhotosPlugin',
  'ForgeLiveActivityPlugin',
]

for (const plugin of plugins) {
  check(fs.existsSync(path.join(appDir, `${plugin}.swift`)), `${plugin}.swift exists`)
  check(viewController.includes(`registerPluginInstance(${plugin}())`), `${plugin} is registered with Capacitor`)
  check(project.includes(`${plugin}.swift in Sources`), `${plugin} is compiled by the app target`)
}

for (const key of [
  'NSHealthShareUsageDescription',
  'NSHealthUpdateUsageDescription',
  'NSContactsUsageDescription',
  'NSPhotoLibraryAddUsageDescription',
  'NSLocationWhenInUseUsageDescription',
  'NSLocationAlwaysAndWhenInUseUsageDescription',
]) {
  check(plistString(infoPlist, key).length >= 20, `${key} has a user-facing purpose string`)
}

check(/<key>NSSupportsLiveActivities<\/key>\s*<true\/>/.test(infoPlist), 'Live Activities are enabled')
check(/<key>UIBackgroundModes<\/key>[\s\S]*?<string>location<\/string>/.test(infoPlist), 'background location mode is enabled')
check(/<key>com\.apple\.developer\.healthkit<\/key>\s*<true\/>/.test(entitlements), 'HealthKit entitlement is enabled')
check(/<key>com\.apple\.developer\.healthkit\.background-delivery<\/key>\s*<true\/>/.test(entitlements), 'HealthKit background delivery entitlement is enabled')
check(project.includes('ForgeRunActivity.appex in Embed App Extensions'), 'Live Activity extension is embedded in the app')
check(packageSwift.includes('CapacitorCommunityBackgroundGeolocation'), 'background geolocation plugin is linked through Swift Package Manager')
check(packageSwift.includes('CapacitorApp'), 'Capacitor App lifecycle plugin is linked through Swift Package Manager')

if (process.platform === 'darwin') {
  const swiftFiles = [
    ...fs.readdirSync(appDir).filter((name) => name.endsWith('.swift')).map((name) => path.join(appDir, name)),
    path.join(iosRoot, 'ForgeRunActivity/ForgeRunActivityBundle.swift'),
    path.join(iosRoot, 'ForgeRunActivity/ForgeRunLiveActivity.swift'),
  ]
  const parsed = spawnSync('xcrun', ['swiftc', '-parse', ...swiftFiles], { encoding: 'utf8' })
  assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout || 'Swift parse failed')
  assertions += 1
}

console.log(`IOS NATIVE CONTRACT OK (${assertions})`)
