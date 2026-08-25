import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const studio = readFileSync(new URL('../src/components/ActivityShareStudio.jsx', import.meta.url), 'utf8')

function functionSource(name, nextName) {
  const start = studio.indexOf(`function ${name}(`)
  const end = studio.indexOf(`\nfunction ${nextName}(`, start)
  assert.notEqual(start, -1, `${name} exists`)
  assert.notEqual(end, -1, `${name} has a stable source boundary`)
  return studio.slice(start, end)
}

const photoTemplate = functionSource('drawPhotoTemplate', 'captionForRun')
const overlayTemplate = functionSource('drawOverlayTemplate', 'drawPhotoTemplate')

assert.match(
  photoTemplate,
  /drawCoverImage\(ctx,\s*photo,\s*0,\s*0,\s*CARD_WIDTH,\s*CARD_HEIGHT\)/,
  'the selected photo still owns the complete card canvas',
)
assert.doesNotMatch(
  photoTemplate,
  /fillStyle\s*=\s*['"]rgba\(7,5,3,0\.96\)['"][\s\S]{0,100}fillRect\(0,\s*CARD_HEIGHT\s*-\s*324,\s*CARD_WIDTH,\s*324\)/,
  'the old near-opaque 324px summary slab is absent',
)
assert.match(
  photoTemplate,
  /createLinearGradient\(0,\s*photoFadeTop,\s*0,\s*CARD_HEIGHT\)/,
  'the lower fade continues to the bottom edge',
)
assert.match(
  photoTemplate,
  /fillRect\(0,\s*photoFadeTop,\s*CARD_WIDTH,\s*CARD_HEIGHT\s*-\s*photoFadeTop\)/,
  'the lower fade fill reaches CARD_HEIGHT',
)
const finalFadeStop = photoTemplate.match(
  /photoFade\.addColorStop\(1,\s*['"]rgba\([^,]+,[^,]+,[^,]+,\s*(0?\.\d+)\)['"]\)/,
)
assert.ok(finalFadeStop, 'the lower fade declares a translucent final color stop')
const finalFadeAlpha = Number(finalFadeStop[1])
assert.ok(finalFadeAlpha >= 0.72 && finalFadeAlpha <= 0.82, 'the lower fade remains within the approved translucent range')
assert.ok(finalFadeAlpha < 0.9, 'the lower fade remains translucent at the bottom edge')

assert.match(photoTemplate, /titleForRun\(run\)/, 'the dynamic run title remains rendered')
assert.match(photoTemplate, /formatDate\(run\.date \|\| run\.created_at\)/, 'the dynamic run date remains rendered')
for (const label of ['Distance', 'Time', 'Pace']) {
  assert.match(photoTemplate, new RegExp(`\\['${label}'`), `${label} remains rendered in the Photo template`)
}

assert.match(studio, /const transparent = template === 'overlay'/, 'only the Overlay template selects transparency')
assert.match(studio, /const fileType = transparent \? 'image\/png' : 'image\/jpeg'/, 'Photo and other opaque templates still export JPEG')
assert.match(studio, /template === 'photo'\) drawPhotoTemplate\(/, 'the Photo template remains wired to its renderer')
assert.match(studio, /await PhotoLibraryService\.saveImage\(file\)/, 'Save still sends the generated file to the photo library service')
assert.match(overlayTemplate, /ctx\.clearRect\(0,\s*0,\s*CARD_WIDTH,\s*CARD_HEIGHT\)/, 'the separate Overlay template still starts from a transparent canvas')

console.log('ACTIVITY SHARE PHOTO OVERLAY SMOKE OK (full-bleed photo, translucent fade, content, JPEG/save, transparent overlay)')
