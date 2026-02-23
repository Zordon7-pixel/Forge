import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'

export default function Register() {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const onSubmit = async e => {
    e.preventDefault(); setError(''); setLoading(true)
    try {
      const response = await api.post('/auth/register', { name, email, password })
      localStorage.setItem('forge_token', response.data.token)
      window.location.href = '/onboarding'
    } catch (err) { setError(err?.response?.data?.error || 'Registration failed. Please try again.') }
    finally { setLoading(false) }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <div className="w-full max-w-[420px] rounded-2xl border p-6 shadow-xl" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <h1 className="mb-1 text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('auth.register')}</h1>
        <p className="mb-6 text-sm" style={{ color: 'var(--text-muted)' }}>Start building your smartest training cycle.</p>

        <form onSubmit={onSubmit} className="space-y-4">
          <input type="text" required placeholder={t('auth.name')} className="w-full rounded-xl border px-4 py-3 outline-none placeholder:text-gray-500 focus:ring-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} value={name} onChange={e => setName(e.target.value)} />
          <input type="email" required placeholder={t('auth.email')} className="w-full rounded-xl border px-4 py-3 outline-none placeholder:text-gray-500 focus:ring-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} value={email} onChange={e => setEmail(e.target.value)} />
          <input type="password" required placeholder={t('auth.password')} className="w-full rounded-xl border px-4 py-3 outline-none placeholder:text-gray-500 focus:ring-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} value={password} onChange={e => setPassword(e.target.value)} />
          <button type="submit" disabled={loading} className="w-full rounded-xl py-3 font-semibold transition hover:opacity-90 disabled:opacity-70" style={{ background: 'var(--accent)', color: 'black' }}>{loading ? t('common.loading') : t('auth.register')}</button>
        </form>

        {error && <p className="mt-3 text-sm" style={{ color: 'var(--accent)' }}>{error}</p>}

        <p className="mt-5 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          {t('auth.hasAccount')} <Link to="/login" className="font-semibold hover:underline" style={{ color: 'var(--accent)' }}>{t('auth.login')}</Link>
        </p>
      </div>
    </div>
  )
}
