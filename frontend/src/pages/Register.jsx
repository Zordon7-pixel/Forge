import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import api from '../lib/api'

export default function Register() {
  const [form, setForm] = useState({ name:'', email:'', password:'', confirm:'' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const f = v => setForm(p => ({...p, ...v}))

  async function submit(e) {
    e.preventDefault(); setError('')
    if (form.password !== form.confirm) { setError('Passwords do not match'); return }
    if (form.password.length < 6) { setError('Password must be at least 6 characters'); return }
    setLoading(true)
    try {
      const { data } = await api.post('/auth/register', { name: form.name, email: form.email, password: form.password })
      localStorage.setItem('forge_token', data.token)
      navigate('/onboarding')
    } catch (e) {
      setError(e?.response?.data?.error || 'Something went wrong')
    } finally { setLoading(false) }
  }

  const inp = 'w-full bg-[#09090f] border border-[#2a2d3e] rounded-xl px-4 py-3 text-white text-sm placeholder-slate-700 focus:outline-none focus:border-orange-500 transition-colors'

  return (
    <div className="min-h-screen bg-[#09090f] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-orange-500 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-orange-900/50">
            <span className="text-3xl">🔥</span>
          </div>
          <h1 className="text-3xl font-black text-white">FORGE</h1>
          <p className="text-slate-500 text-sm mt-1">Start your journey</p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <input className={inp} placeholder="Your name" value={form.name} onChange={e => f({name: e.target.value})} required />
          <input type="email" className={inp} placeholder="Email" value={form.email} onChange={e => f({email: e.target.value})} required />
          <input type="password" className={inp} placeholder="Password (6+ chars)" value={form.password} onChange={e => f({password: e.target.value})} required />
          <input type="password" className={inp} placeholder="Confirm password" value={form.confirm} onChange={e => f({confirm: e.target.value})} required />

          {error && <p className="text-red-400 text-xs text-center bg-red-900/20 border border-red-800/30 rounded-xl px-3 py-2">{error}</p>}

          <button type="submit" disabled={loading}
            className="w-full bg-orange-500 hover:bg-orange-400 text-white font-bold rounded-xl py-3.5 text-sm transition-colors disabled:opacity-50">
            {loading ? 'Creating account...' : 'Create Account'}
          </button>
        </form>

        <p className="text-center text-slate-600 text-xs mt-5">
          Already have an account?{' '}
          <Link to="/login" className="text-orange-400 hover:text-orange-300">Sign in →</Link>
        </p>
      </div>
    </div>
  )
}
