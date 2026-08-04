import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MAX_ACTIVITY_SHARE_PHOTO_BYTES,
  unreadableActivitySharePhotoMessage,
  validateActivitySharePhoto,
} from '../src/lib/activitySharePhoto.js'

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
const studio = read('src/components/ActivityShareStudio.jsx')
const recap = read('src/pages/RunRecap.jsx')
let passed = 0
const check = (condition, message) => {
  assert.ok(condition, message)
  passed += 1
}

console.log('\n== deterministic photo policy ==')
check(validateActivitySharePhoto({ type: 'image/jpeg', size: MAX_ACTIVITY_SHARE_PHOTO_BYTES }).ok, 'a browser image at exactly 15 MB is allowed')
check(!validateActivitySharePhoto({ type: 'image/png', size: MAX_ACTIVITY_SHARE_PHOTO_BYTES + 1 }).ok, 'an image over 15 MB is rejected')
check(validateActivitySharePhoto({ type: 'image/png', size: MAX_ACTIVITY_SHARE_PHOTO_BYTES + 1 }).message.includes('15 MB'), 'the oversize rejection is actionable')
check(!validateActivitySharePhoto({ type: 'text/plain', size: 12 }).ok, 'a non-image MIME type is rejected')
check(validateActivitySharePhoto({ type: 'text/plain', size: 12 }).message === 'Choose an image file.', 'the invalid-type rejection is visible and specific')
check(validateActivitySharePhoto({ type: 'image/heic', size: 12 }).ok, 'HEIC reaches browser-readability validation instead of being mislabeled as non-image')
check(/HEIC\/HEIF/.test(unreadableActivitySharePhotoMessage({ type: 'image/heic', name: 'run.heic' })), 'an unreadable HEIC selection gets format-specific guidance')
check(/browser-readable image/.test(unreadableActivitySharePhotoMessage({ type: 'image/webp', name: 'run.webp' })), 'any decode failure gets browser-readable fallback guidance')

console.log('\n== semantic picker and modal gates ==')
check((studio.match(/type="file"/g) || []).length === 1, 'the share studio owns exactly one file input')
check(/ref=\{fileInputRef\}[\s\S]*id=\{photoInputId\}[\s\S]*type="file"[\s\S]*accept="image\/\*"/.test(studio), 'the stable hidden input is ref-backed and image-only')
check(/data-testid="photo-canvas-picker"[\s\S]*aria-controls=\{photoInputId\}[\s\S]*onClick=\{openPhotoPicker\}/.test(studio), 'the large Photo artwork target semantically activates the stable input')
check(/data-testid="photo-control-picker"[\s\S]*aria-controls=\{photoInputId\}[\s\S]*onClick=\{openPhotoPicker\}/.test(studio), 'the lower Add/Change control activates that same input')
const pickerStart = studio.indexOf('const openPhotoPicker = () =>')
const pickerEnd = studio.indexOf('const handlePhoto = async', pickerStart)
const pickerSource = studio.slice(pickerStart, pickerEnd)
check(pickerStart >= 0 && pickerSource.includes("input.value = ''") && pickerSource.includes('input.click()'), 'the visible user gesture synchronously clears and clicks the input')
check(!pickerSource.includes('await ') && !pickerSource.includes('.files ='), 'picker activation neither awaits nor programmatically assigns files')
check(/finally \{[\s\S]*input\.value = ''[\s\S]*\}/.test(studio), 'each completed selection clears the input for same-file reselection')
check(studio.indexOf('await loadImage(nextPhotoUrl)') < studio.indexOf('setPhotoUrl(nextPhotoUrl)'), 'a selected image decodes before it replaces the preview')
check(/role=\{photoFeedback\.kind === 'error' \? 'alert' : 'status'\}/.test(studio), 'selected-photo and error feedback are exposed visibly and accessibly')
check(/photoUrl \? 'Change photo' : 'Add a photo'/.test(studio), 'the lower control exposes selected-photo state')
check(/if \(photoUrl\) revokeOwnedPhotoUrl\(photoUrl\)/.test(studio), 'replacement revokes the previous preview URL')
check(/for \(const url of ownedPhotoUrlsRef\.current\) URL\.revokeObjectURL\(url\)/.test(studio), 'closing the studio revokes every owned preview URL')
check(/role="dialog"[\s\S]*aria-modal="true"[\s\S]*aria-labelledby="share-studio-title"/.test(studio), 'the studio exposes true modal semantics')
check(studio.includes("event.key === 'Escape'") && studio.includes("event.key !== 'Tab'"), 'Escape closes and Tab is trapped inside the dialog')
check(studio.includes("body.style.overflow = 'hidden'") && studio.includes('body.style.overflow = previousBodyStyle.overflow'), 'body overflow is locked and restored exactly')
check(studio.includes('body.style.position = previousBodyStyle.position') && studio.includes('window.scrollTo(scrollX, scrollY)'), 'iOS scroll position and prior inline body styles are restored on close')
check(studio.includes('data-testid="share-studio-scrollport"') && studio.includes('min-h-0 flex-1 overflow-y-auto overscroll-contain'), 'modal content uses a bounded internal scrollport')
check(studio.includes('safe-area-inset-top') && studio.includes('safe-area-inset-bottom'), 'the modal accounts for both mobile safe areas')
check(/data-testid="share-studio-backdrop"[\s\S]*background: 'var\(--bg-base\)'/.test(studio), 'the share studio owns an opaque full viewport')
check(studio.includes('if (event.target === event.currentTarget)') && studio.includes('event.stopPropagation()'), 'backdrop interaction closes deliberately without leaking clicks behind it')
check(recap.includes('data-testid="run-recap-viewport"') && recap.includes("background: 'var(--bg-base)'"), 'the completed-run recap remains an opaque owner behind the modal')

console.log(`\nACTIVITY SHARE STUDIO PHASE C SMOKE OK (${passed})`)
