import { useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import api from '../lib/api'

export default function ResetPassword() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const token = searchParams.get('token') || ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (password !== confirm) return setError('Passwords do not match.')
    if (password.length < 6) return setError('Password must be at least 6 characters.')
    setLoading(true)
    try {
      await api.post('/auth/reset-password', { token, password })
      setSuccess(true)
    } catch (err) {
      setError(err?.response?.data?.error || 'Reset failed. The link may have expired.')
    } finally {
      setLoading(false)
    }
  }

  const inputStyle = { borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }
  const btnStyle = { background: 'var(--accent)', color: 'black' }

  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <div className="w-full max-w-[420px] rounded-2xl border p-6 shadow-xl" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>

        {success ? (
          <>
            <h1 className="mb-2 text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Password Updated</h1>
            <p className="mb-6 text-sm" style={{ color: 'var(--text-muted)' }}>You can now sign in with your new password.</p>
            <button onClick={() => navigate('/login')} className="w-full rounded-xl py-3 font-semibold transition hover:opacity-90" style={btnStyle}>
              Go to Sign In
            </button>
          </>
        ) : (
          <>
            <h1 className="mb-1 text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Set New Password</h1>
            <p className="mb-6 text-sm" style={{ color: 'var(--text-muted)' }}>Choose a new password for your account.</p>

            {!token && (
              <p className="mb-4 text-sm" style={{ color: 'var(--accent)' }}>Missing reset token. Please use the link from the console.</p>
            )}

            <form onSubmit={submit} className="space-y-4">
              <input type="password" required placeholder="New password" className="w-full rounded-xl border px-4 py-3 outline-none placeholder:text-gray-500 focus:ring-2" style={inputStyle} value={password} onChange={e => setPassword(e.target.value)} />
              <input type="password" required placeholder="Confirm new password" className="w-full rounded-xl border px-4 py-3 outline-none placeholder:text-gray-500 focus:ring-2" style={inputStyle} value={confirm} onChange={e => setConfirm(e.target.value)} />
              {error && <p className="text-sm" style={{ color: 'var(--accent)' }}>{error}</p>}
              <button type="submit" disabled={loading || !token} className="w-full rounded-xl py-3 font-semibold transition hover:opacity-90 disabled:opacity-70" style={btnStyle}>
                {loading ? 'Updating...' : 'Set New Password'}
              </button>
            </form>

            <button type="button" onClick={() => navigate('/login')}
              className="mt-4 w-full text-sm hover:underline" style={{ color: 'var(--text-muted)' }}>
              Back to sign in
            </button>
          </>
        )}
      </div>
    </div>
  )
}
