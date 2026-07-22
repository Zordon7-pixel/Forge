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
assert.match(studio, /choose Save Image in the share sheet/, 'an older native shell gets an honest iOS share-sheet fallback')
assert.match(service, /Capacitor\.isPluginAvailable\('ForgePhotos'\)/, 'web code detects whether the native plugin is bundled')
assert.match(plugin, /requestAuthorization\(for: \.addOnly/, 'the plugin requests add-only Photos access')
assert.match(plugin, /request\.addResource\(with: \.photo, data: data/, 'the rendered image bytes are added to Photos')
assert.match(appViewController, /registerPluginInstance\(ForgePhotosPlugin\(\)\)/, 'the native bridge registers the Photos plugin')
assert.match(plist, /<key>NSPhotoLibraryAddUsageDescription<\/key>/, 'the native app declares its Photos save purpose')
assert.match(project, /ForgePhotosPlugin\.swift in Sources/, 'the Photos bridge is compiled into the iOS target')

console.log('PHOTO LIBRARY SAVE SMOKE OK (8)')
