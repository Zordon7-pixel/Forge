import { Capacitor, registerPlugin } from '@capacitor/core'

const ForgePhotos = registerPlugin('ForgePhotos')

function isNativeRuntime() {
  return Boolean(Capacitor?.isNativePlatform?.())
}

function fileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Share card could not be read'))
    reader.readAsDataURL(file)
  })
}

const PhotoLibraryService = {
  isDirectSaveAvailable() {
    return isNativeRuntime() && Capacitor.isPluginAvailable('ForgePhotos')
  },

  async saveImage(file) {
    if (!isNativeRuntime()) return { saved: false, reason: 'web' }
    if (!Capacitor.isPluginAvailable('ForgePhotos')) {
      return { saved: false, requiresNativeUpdate: true }
    }
    try {
      const result = await ForgePhotos.saveImage({
        dataUrl: await fileDataUrl(file),
        filename: file.name,
      })
      return { saved: Boolean(result?.saved) }
    } catch (error) {
      const message = String(error?.message || error || '')
      if (/not implemented|plugin is not implemented|unavailable/i.test(message)) {
        return { saved: false, requiresNativeUpdate: true }
      }
      throw error
    }
  },
}

export default PhotoLibraryService
