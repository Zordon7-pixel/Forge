export const MAX_ACTIVITY_SHARE_PHOTO_BYTES = 15 * 1024 * 1024

export function validateActivitySharePhoto(file) {
  if (!file) return { ok: false, message: '' }
  if (!String(file.type || '').toLowerCase().startsWith('image/')) {
    return { ok: false, message: 'Choose an image file.' }
  }
  if (Number(file.size) > MAX_ACTIVITY_SHARE_PHOTO_BYTES) {
    return { ok: false, message: 'Choose a photo smaller than 15 MB.' }
  }
  return { ok: true, message: '' }
}

export function unreadableActivitySharePhotoMessage(file) {
  const type = String(file?.type || '').toLowerCase()
  const name = String(file?.name || '').toLowerCase()
  const isHeic = type.includes('heic') || type.includes('heif') || /\.hei[cf]$/.test(name)
  return isHeic
    ? 'This HEIC/HEIF photo could not be read in this app. Choose a JPEG, PNG, or another browser-readable image.'
    : 'This photo could not be read in this app. Choose a JPEG, PNG, or another browser-readable image.'
}
