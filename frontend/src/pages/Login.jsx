import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { setToken } from '../lib/tokenStore'

export default function Login() {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const [forgotMode, setForgotMode] = useState(false)
  const [forgotEmail, setForgotEmail] = useState('')
  const [forgotMsg, setForgotMsg] = useState('')
  const [forgotMsgType, setForgotMsgType] = useState('info')
  const [forgotLoading, setForgotLoading] = useState(false)

  const onSubmit = async e => {
    e.preventDefault(); setError(''); setLoading(true)
    try {
      const response = await api.post('/auth/login', { email, password })
      setToken(response.data.token)
      window.location.href = '/'
    } catch { setError('Wrong email or password.') }
    finally { setLoading(false) }
  }

  const onForgot = async e => {
    e.preventDefault()
    setForgotMsg('')
    setForgotMsgType('info')
    setForgotLoading(true)

    try {
      const response = await api.post('/auth/forgot-password', { email: forgotEmail })
      setForgotMsg(response.data?.message || 'If an account exists for that email, a password reset link has been sent.')
      setForgotMsgType(response.data?.status === 'email_unavailable' ? 'error' : 'info')
    } catch (err) {
      const data = err?.response?.data
      setForgotMsg(data?.message || data?.error || 'Something went wrong. Please try again.')
      setForgotMsgType('error')
    } finally {
      setForgotLoading(false)
    }
  }

  const inputStyle = { borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }
  const btnStyle = { background: 'var(--accent)', color: 'var(--on-accent)' }

  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <div className="w-full max-w-[420px]">
        <div className="mb-6 text-center">
          <img src="/icon-192.png" alt="Forged Hybrid" className="mx-auto h-14 w-14 rounded-2xl object-cover" />
          <p className="t-title mt-3 tracking-[0.14em]" style={{ color: 'var(--text-primary)' }}>Forged Hybrid</p>
          <p className="t-sub mt-1">Coach for runners who lift.</p>
        </div>
        <div className="card p-6">

        {!forgotMode ? (
          <>
            <h1 className="mb-1 text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('auth.login')}</h1>
            <p className="mb-6 text-sm" style={{ color: 'var(--text-muted)' }}>{t('auth.login')} to continue your training.</p>

            <form onSubmit={onSubmit} className="space-y-4">
              <input type="email" required placeholder={t('auth.email')} className="w-full rounded-xl border px-4 py-3 outline-none placeholder:text-gray-500 focus:ring-2" style={inputStyle} value={email} onChange={e => setEmail(e.target.value)} />
              <input type="password" required placeholder={t('auth.password')} className="w-full rounded-xl border px-4 py-3 outline-none placeholder:text-gray-500 focus:ring-2" style={inputStyle} value={password} onChange={e => setPassword(e.target.value)} />
              <button type="submit" disabled={loading} className="pressable w-full rounded-xl py-3 font-semibold transition hover:opacity-90 disabled:opacity-70" style={btnStyle}>{loading ? t('common.loading') : t('auth.login')}</button>
            </form>

            {error && <p className="mt-3 text-sm" style={{ color: 'var(--accent)' }}>{error}</p>}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {t('auth.noAccount')} <Link to="/register" className="whitespace-nowrap font-semibold hover:underline" style={{ color: 'var(--accent)' }}>{t('auth.register')}</Link>
              </p>
              <button type="button" onClick={() => { setForgotMode(true); setForgotMsg(''); setForgotMsgType('info') }}
                className="whitespace-nowrap text-sm hover:underline" style={{ color: 'var(--text-muted)' }}>
                Forgot password?
              </button>
            </div>
          </>
        ) : (
          <>
            <h1 className="mb-1 text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Reset Password</h1>
            <p className="mb-6 text-sm" style={{ color: 'var(--text-muted)' }}>Enter your email and, if an account exists, we will send a password reset link.</p>

            <form onSubmit={onForgot} className="space-y-4">
              <input type="email" required placeholder="Your email address" className="w-full rounded-xl border px-4 py-3 outline-none placeholder:text-gray-500 focus:ring-2" style={inputStyle} value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} />
              <button type="submit" disabled={forgotLoading} className="pressable w-full rounded-xl py-3 font-semibold transition hover:opacity-90 disabled:opacity-70" style={btnStyle}>{forgotLoading ? 'Sending...' : 'Send Reset Link'}</button>
            </form>

            {forgotMsg && (
              <p className="mt-3 text-sm" style={{ color: forgotMsgType === 'error' ? 'var(--accent)' : 'var(--text-muted)' }}>
                {forgotMsg}
              </p>
            )}

            <button type="button" onClick={() => setForgotMode(false)}
              className="mt-4 w-full text-sm hover:underline" style={{ color: 'var(--text-muted)' }}>
              Back to sign in
            </button>
          </>
        )}
        </div>
      </div>
    </div>
  )
}
