import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
const studio = read('frontend/src/components/ActivityShareStudio.jsx')
const service = read('frontend/src/services/PhotoLibraryService.js')
const plugin = read('frontend/ios/App/App/ForgePhotosPlugin.swift')
const appViewController = read('frontend/ios/App/App/AppViewController.swift')
const plist = read('frontend/ios/App/App/Info.plist')
const project = read('frontend/ios/App/App.xcodeproj/project.pbxproj')

assert.match(studio, /await PhotoLibraryService\.saveImage\(file\)/, 'Save first attempts the native Photos library')
assert.match(studio, /choose Save Image/, 'an older native shell gets an honest iOS share-sheet fallback')
assert.match(service, /isNativeRuntime\(\) \{[\s\S]*return isNativeRuntime\(\)/, 'the UI can identify a native shell before Save is tapped')
assert.match(studio, /usesLegacyPhotoSave = PhotoLibraryService\.isNativeRuntime\(\) && !PhotoLibraryService\.isDirectSaveAvailable\(\)/, 'old-shell guidance is selected before user interaction')
assert.ok(studio.indexOf('On this app build, Save opens the iPhone share sheet.') < studio.indexOf('onClick={handleSave}'), 'the Save Image instruction is already rendered above the Save control')
assert.match(service, /Capacitor\.isPluginAvailable\('ForgePhotos'\)/, 'web code detects whether the native plugin is bundled')
assert.match(plugin, /requestAuthorization\(for: \.addOnly/, 'the plugin requests add-only Photos access')
assert.match(plugin, /request\.addResource\(with: \.photo, data: data/, 'the rendered image bytes are added to Photos')
assert.match(plugin, /data:image\/png;base64,/, 'the bridge allowlists PNG data URLs')
assert.match(plugin, /data:image\/jpeg;base64,/, 'the bridge allowlists JPEG data URLs')
assert.doesNotMatch(plugin, /ignoreUnknownCharacters/, 'invalid Base64 characters are rejected')
assert.match(plugin, /encoded\.count <= maximumEncodedLength/, 'oversized payloads are rejected before decode')
assert.match(plugin, /0x89, 0x50, 0x4E, 0x47/, 'PNG bytes must have a PNG signature')
assert.match(plugin, /0xFF, 0xD8, 0xFF/, 'JPEG bytes must have a JPEG signature')
assert.match(plugin, /\[\^A-Za-z0-9\._-\]\+/, 'native filenames are reduced to an allowlist')
assert.match(appViewController, /registerPluginInstance\(ForgePhotosPlugin\(\)\)/, 'the native bridge registers the Photos plugin')
assert.match(plist, /<key>NSPhotoLibraryAddUsageDescription<\/key>/, 'the native app declares its Photos save purpose')
assert.match(project, /ForgePhotosPlugin\.swift in Sources/, 'the Photos bridge is compiled into the iOS target')

console.log('PHOTO LIBRARY SAVE SMOKE OK (17)')
