import { useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const onSubmit = async e => {
    e.preventDefault(); setError(''); setLoading(true)
    try {
      const response = await api.post('/auth/login', { email, password })
      localStorage.setItem('forge_token', response.data.token)
      window.location.href = '/'
    } catch { setError('Wrong email or password.') }
    finally { setLoading(false) }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <div className="w-full max-w-[420px] rounded-2xl border p-6 shadow-xl" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <h1 className="mb-1 text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Welcome back</h1>
        <p className="mb-6 text-sm" style={{ color: 'var(--text-muted)' }}>Log in to continue your training.</p>

        <form onSubmit={onSubmit} className="space-y-4">
          <input type="email" required placeholder="Email" className="w-full rounded-xl border px-4 py-3 outline-none placeholder:text-gray-500 focus:ring-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', boxShadow: '0 0 0 0 rgba(0,0,0,0)' }} value={email} onChange={e => setEmail(e.target.value)} />
          <input type="password" required placeholder="Password" className="w-full rounded-xl border px-4 py-3 outline-none placeholder:text-gray-500 focus:ring-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} value={password} onChange={e => setPassword(e.target.value)} />
          <button type="submit" disabled={loading} className="w-full rounded-xl py-3 font-semibold transition hover:opacity-90 disabled:opacity-70" style={{ background: 'var(--accent)', color: 'black' }}>{loading ? 'Logging in...' : 'Log In'}</button>
        </form>

        {error && <p className="mt-3 text-sm" style={{ color: 'var(--accent)' }}>{error}</p>}

        <p className="mt-5 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          New to FORGE? <Link to="/register" className="font-semibold hover:underline" style={{ color: 'var(--accent)' }}>Create account</Link>
        </p>
      </div>
    </div>
  )
}
