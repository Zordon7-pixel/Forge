import { useState, useRef } from 'react'
import { Camera, Check } from 'lucide-react'
import api from '../lib/api'

export default function PhotoUploader({ activityId, activityType, existingPhoto = null }) {
  const [preview, setPreview] = useState(existingPhoto)
  const [uploading, setUploading] = useState(false)
  const [done, setDone] = useState(!!existingPhoto)
  const fileRef = useRef()

  const handleFile = async file => {
    if (!file || !activityId || !activityType) return

    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = async () => {
      const canvas = document.createElement('canvas')
      const MAX = 800
      const ratio = Math.min(MAX / img.width, MAX / img.height, 1)
      canvas.width = img.width * ratio
      canvas.height = img.height * ratio
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.75)
      setPreview(dataUrl)
      setUploading(true)
      try {
        await api.post(`/social/${activityType}/${activityId}/photo`, { data: dataUrl, mime_type: 'image/jpeg' })
        setDone(true)
      } catch (err) {
        console.error('Photo upload error:', err)
        alert('Photo upload failed. Try a smaller image.')
        setPreview(null)
      } finally {
        setUploading(false)
      }
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      console.error('Failed to load image')
      alert('Could not load image. Try another file.')
      URL.revokeObjectURL(url)
    }
    img.src = url
  }

  return (
    <div>
      {preview ? (
        <div className="relative">
          <img src={preview} alt="Workout photo" style={{ width: '100%', borderRadius: 12, maxHeight: 220, objectFit: 'cover' }} />
          {done && (
            <div className="absolute top-2 right-2 rounded-full p-1" style={{ background: 'var(--accent)' }}>
              <Check size={14} color="#000" />
            </div>
          )}
          {!done && uploading && (
            <div className="absolute inset-0 flex items-center justify-center rounded-xl" style={{ background: 'rgba(0,0,0,0.5)' }}>
              <span className="text-xs font-bold text-white">Uploading...</span>
            </div>
          )}
        </div>
      ) : (
        <button
          onClick={() => fileRef.current.click()}
          className="w-full py-3 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold"
          style={{ background: 'var(--bg-input)', border: '1.5px dashed var(--border-subtle)', color: 'var(--text-muted)' }}
        >
          <Camera size={16} />
          Add workout photo
        </button>
      )}
      <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
    </div>
  )
}
