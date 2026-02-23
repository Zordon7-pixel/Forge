import { X } from 'lucide-react'

export default function PhotoViewer({ src, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.95)' }} onClick={onClose}>
      <button className="absolute top-5 right-5" onClick={onClose}><X size={24} color="white" /></button>
      <img src={src} alt="Activity photo" style={{ maxWidth: '100%', maxHeight: '90vh', objectFit: 'contain', borderRadius: 12 }} onClick={e => e.stopPropagation()} />
    </div>
  )
}
