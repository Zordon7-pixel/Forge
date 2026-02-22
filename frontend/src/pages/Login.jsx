import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import api from '../lib/api'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  async function submit(e) {
    e.preventDefault(); setError(''); setLoading(true)
    try {
      const { data } = await api.post('/auth/login', { email, password })
      localStorage.setItem('forge_token', data.token)
      navigate(data.user.onboarded ? '/' : '/onboarding')
    } catch (e) {
      setError(e?.response?.data?.error || 'Something went wrong')
    } finally { setLoading(false) }
  }

  const inp = 'w-full bg-[#09090f] border border-[#2a2d3e] rounded-xl px-4 py-3 text-white text-sm placeholder-slate-700 focus:outline-none focus:border-orange-500 transition-colors'

  return (
    <div className="min-h-screen bg-[#09090f] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-10">
          <div className="w-20 h-20 bg-orange-500 rounded-3xl flex items-center justify-center mx-auto mb-5 shadow-2xl shadow-orange-900/60">
            <span className="text-4xl">🔥</span>
          </div>
          <h1 className="text-4xl font-black text-white tracking-tight">FORGE</h1>
          <p className="text-orange-400 text-sm font-semibold mt-1 tracking-widest uppercase">Built to adapt.</p>
          <p className="text-slate-500 text-xs mt-3">Train smarter. Recover faster. Never get injured twice.</p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <input type="email" className={inp} placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
          <input type="password" className={inp} placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required />

          {error && <p className="text-red-400 text-xs text-center bg-red-900/20 border border-red-800/30 rounded-xl px-3 py-2">{error}</p>}

          <button type="submit" disabled={loading}
            className="w-full bg-orange-500 hover:bg-orange-400 text-white font-bold rounded-xl py-3.5 text-sm transition-colors disabled:opacity-50 shadow-lg shadow-orange-900/40">
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p className="text-center text-slate-600 text-xs mt-6">
          New here?{' '}
          <Link to="/register" className="text-orange-400 hover:text-orange-300 transition-colors">Create your account →</Link>
        </p>

        <div className="mt-8 bg-[#111318] border border-[#1f2028] rounded-xl p-4 text-center">
          <p className="text-xs text-slate-500 mb-1">Try the demo</p>
          <p className="text-xs text-slate-400 font-mono">demo@forge.app / demo1234</p>
        </div>
      </div>
    </div>
  )
}
