import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'

export default function Login() {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const [forgotMode, setForgotMode] = useState(false)
  const [forgotEmail, setForgotEmail] = useState('')
  const [forgotMsg, setForgotMsg] = useState('')
  const [forgotLoading, setForgotLoading] = useState(false)

  const onSubmit = async e => {
    e.preventDefault(); setError(''); setLoading(true)
    try {
      const response = await api.post('/auth/login', { email, password })
      localStorage.setItem('forge_token', response.data.token)
      window.location.href = '/'
    } catch { setError('Wrong email or password.') }
    finally { setLoading(false) }
  }

  const onForgot = async e => {
    e.preventDefault(); setForgotMsg(''); setForgotLoading(true)
    try {
      await api.post('/auth/forgot-password', { email: forgotEmail })
      setForgotMsg('If that email exists, a reset link has been logged to the server console.')
    } catch { setForgotMsg('Something went wrong. Please try again.') }
    finally { setForgotLoading(false) }
  }

  const inputStyle = { borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }
  const btnStyle = { background: 'var(--accent)', color: 'black' }

  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <div className="w-full max-w-[420px] rounded-2xl border p-6 shadow-xl" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>

        {!forgotMode ? (
          <>
            <h1 className="mb-1 text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('auth.login')}</h1>
            <p className="mb-6 text-sm" style={{ color: 'var(--text-muted)' }}>{t('auth.login')} to continue your training.</p>

            <form onSubmit={onSubmit} className="space-y-4">
              <input type="email" required placeholder={t('auth.email')} className="w-full rounded-xl border px-4 py-3 outline-none placeholder:text-gray-500 focus:ring-2" style={inputStyle} value={email} onChange={e => setEmail(e.target.value)} />
              <input type="password" required placeholder={t('auth.password')} className="w-full rounded-xl border px-4 py-3 outline-none placeholder:text-gray-500 focus:ring-2" style={inputStyle} value={password} onChange={e => setPassword(e.target.value)} />
              <button type="submit" disabled={loading} className="w-full rounded-xl py-3 font-semibold transition hover:opacity-90 disabled:opacity-70" style={btnStyle}>{loading ? t('common.loading') : t('auth.login')}</button>
            </form>

            {error && <p className="mt-3 text-sm" style={{ color: 'var(--accent)' }}>{error}</p>}

            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {t('auth.noAccount')} <Link to="/register" className="font-semibold hover:underline" style={{ color: 'var(--accent)' }}>{t('auth.register')}</Link>
              </p>
              <button type="button" onClick={() => { setForgotMode(true); setForgotMsg('') }}
                className="text-sm hover:underline" style={{ color: 'var(--text-muted)' }}>
                Forgot password?
              </button>
            </div>
          </>
        ) : (
          <>
            <h1 className="mb-1 text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Reset Password</h1>
            <p className="mb-6 text-sm" style={{ color: 'var(--text-muted)' }}>Enter your email and we will log a reset link to the server console.</p>

            <form onSubmit={onForgot} className="space-y-4">
              <input type="email" required placeholder="Your email address" className="w-full rounded-xl border px-4 py-3 outline-none placeholder:text-gray-500 focus:ring-2" style={inputStyle} value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} />
              <button type="submit" disabled={forgotLoading} className="w-full rounded-xl py-3 font-semibold transition hover:opacity-90 disabled:opacity-70" style={btnStyle}>{forgotLoading ? 'Sending...' : 'Send Reset Link'}</button>
            </form>

            {forgotMsg && <p className="mt-3 text-sm" style={{ color: 'var(--accent)' }}>{forgotMsg}</p>}

            <button type="button" onClick={() => setForgotMode(false)}
              className="mt-4 w-full text-sm hover:underline" style={{ color: 'var(--text-muted)' }}>
              Back to sign in
            </button>
          </>
        )}
      </div>
    </div>
  )
}
