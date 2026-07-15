import { useEffect, useRef, useState } from 'react'
import { ImagePlus, LockKeyhole, Trash2 } from 'lucide-react'
import api from '../lib/api'

const MAX_PHOTOS = 4
const MAX_DATA_LENGTH = 950000

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const objectUrl = URL.createObjectURL(file)
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('That image could not be opened.'))
    }
    image.src = objectUrl
  })
}

async function preparePhoto(file) {
  const image = await loadImage(file)
  const maxDimensions = [1200, 1000, 800, 640]
  const qualities = [0.8, 0.68, 0.55]

  for (const maxDimension of maxDimensions) {
    const ratio = Math.min(maxDimension / image.naturalWidth, maxDimension / image.naturalHeight, 1)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This device could not prepare the image.')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)

    for (const quality of qualities) {
      const data = canvas.toDataURL('image/jpeg', quality)
      if (data.length <= MAX_DATA_LENGTH) return data
    }
  }

  throw new Error('That photo is too large. Choose a smaller image.')
}

export default function RunMediaManager({ runId }) {
  const inputRef = useRef(null)
  const [photos, setPhotos] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [confirmingId, setConfirmingId] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true

    async function loadPhotos() {
      setLoading(true)
      setError('')
      try {
        const response = await api.get(`/social/run/${encodeURIComponent(runId)}/photos`)
        const metadata = Array.isArray(response.data?.media) ? response.data.media : []
        const resolved = await Promise.all(metadata.map(async (photo) => {
          try {
            const itemResponse = await api.get(
              `/social/run/${encodeURIComponent(runId)}/photos/${encodeURIComponent(photo.id)}`
            )
            return itemResponse.data?.media || null
          } catch (requestError) {
            console.error('[RunMediaManager] photo fetch failed:', requestError?.message || requestError)
            return null
          }
        }))
        if (active) setPhotos(resolved.filter(Boolean))
      } catch (requestError) {
        console.error('[RunMediaManager] gallery load failed:', requestError?.message || requestError)
        if (active) setError(requestError?.response?.data?.error || 'Could not load run photos.')
      } finally {
        if (active) setLoading(false)
      }
    }

    if (runId) loadPhotos()
    return () => { active = false }
  }, [runId])

  const addPhotos = async (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length || uploading) return

    const remaining = Math.max(0, MAX_PHOTOS - photos.length)
    if (!remaining) {
      setError(`Each run can have up to ${MAX_PHOTOS} photos.`)
      return
    }

    const selected = files.slice(0, remaining)
    setUploading(true)
    setError(files.length > remaining ? `Only the first ${remaining} photo${remaining === 1 ? '' : 's'} will be added.` : '')

    try {
      for (const file of selected) {
        const data = await preparePhoto(file)
        const createResponse = await api.post(`/social/run/${encodeURIComponent(runId)}/photos`, {
          data,
          mime_type: 'image/jpeg',
        })
        const mediaId = createResponse.data?.media?.id
        if (!mediaId) throw new Error('The photo was saved without an identifier.')
        const itemResponse = await api.get(
          `/social/run/${encodeURIComponent(runId)}/photos/${encodeURIComponent(mediaId)}`
        )
        const media = itemResponse.data?.media
        if (media) setPhotos((current) => [...current, media])
      }
    } catch (requestError) {
      console.error('[RunMediaManager] upload failed:', requestError?.message || requestError)
      setError(requestError?.response?.data?.error || requestError?.message || 'Could not add the photo.')
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const removePhoto = async (mediaId) => {
    if (deletingId) return
    setDeletingId(mediaId)
    setError('')
    try {
      await api.delete(
        `/social/run/${encodeURIComponent(runId)}/photos/${encodeURIComponent(mediaId)}`
      )
      setPhotos((current) => current.filter((photo) => photo.id !== mediaId))
      setConfirmingId(null)
    } catch (requestError) {
      console.error('[RunMediaManager] delete failed:', requestError?.message || requestError)
      setError(requestError?.response?.data?.error || 'Could not remove the photo.')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <section className="mx-auto mb-5 w-full max-w-2xl rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>Run photos</h2>
          <p className="mt-1 flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
            <LockKeyhole size={13} aria-hidden="true" /> Private to you
          </p>
        </div>
        <span className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>{photos.length}/{MAX_PHOTOS}</span>
      </div>

      {loading ? (
        <p className="mt-4 text-sm" style={{ color: 'var(--text-muted)' }}>Loading photos...</p>
      ) : photos.length > 0 ? (
        <div className="mt-4 grid grid-cols-2 gap-3">
          {photos.map((photo, index) => (
            <div key={photo.id} className="overflow-hidden rounded-lg border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)' }}>
              <div className="relative aspect-square overflow-hidden">
                <img src={photo.data} alt={`Run photo ${index + 1}`} className="h-full w-full object-cover" />
                <button
                  type="button"
                  title="Remove photo"
                  aria-label={`Remove run photo ${index + 1}`}
                  onClick={() => setConfirmingId(photo.id)}
                  className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full"
                  style={{ background: 'rgba(0,0,0,0.72)', color: '#fff' }}
                >
                  <Trash2 size={17} aria-hidden="true" />
                </button>
              </div>
              {confirmingId === photo.id && (
                <div className="grid grid-cols-2 gap-2 p-2">
                  <button type="button" onClick={() => setConfirmingId(null)} className="rounded-lg border px-2 py-2 text-xs font-semibold" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>Keep</button>
                  <button type="button" disabled={deletingId === photo.id} onClick={() => removePhoto(photo.id)} className="rounded-lg px-2 py-2 text-xs font-bold disabled:opacity-60" style={{ background: 'var(--danger)', color: '#fff' }}>{deletingId === photo.id ? 'Removing...' : 'Remove'}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm" style={{ color: 'var(--text-muted)' }}>No photos saved for this run.</p>
      )}

      {photos.length < MAX_PHOTOS && (
        <button
          type="button"
          disabled={loading || uploading}
          onClick={() => inputRef.current?.click()}
          className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border text-sm font-bold disabled:opacity-60"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
        >
          <ImagePlus size={18} aria-hidden="true" />
          {uploading ? 'Adding photos...' : 'Add photos'}
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => addPhotos(event.target.files)}
      />
      {error && <p className="mt-3 text-sm" role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
    </section>
  )
}
