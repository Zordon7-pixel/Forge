import { useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const onSubmit = async e => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await api.post('/auth/login', { email, password })
      localStorage.setItem('forge_token', response.data.token)
      window.location.href = '/'
    } catch (err) {
      setError(err?.response?.data?.error || 'Login failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#09090f] px-4 text-white">
      <div className="w-full max-w-[420px] rounded-2xl border border-white/10 bg-[#111318] p-6 shadow-xl">
        <h1 className="mb-1 text-2xl font-bold">Welcome back</h1>
        <p className="mb-6 text-sm text-gray-400">Log in to continue your training.</p>

        <form onSubmit={onSubmit} className="space-y-4">
          <input
            type="email"
            required
            placeholder="Email"
            className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3 text-white outline-none ring-orange-500 placeholder:text-gray-500 focus:ring-2"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
          <input
            type="password"
            required
            placeholder="Password"
            className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3 text-white outline-none ring-orange-500 placeholder:text-gray-500 focus:ring-2"
            value={password}
            onChange={e => setPassword(e.target.value)}
          />

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-orange-500 py-3 font-semibold text-white transition hover:opacity-90 disabled:opacity-70"
          >
            {loading ? 'Logging in...' : 'Log In'}
          </button>
        </form>

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        <p className="mt-5 text-center text-sm text-gray-400">
          New to FORGE?{' '}
          <Link to="/register" className="font-semibold text-orange-500 hover:underline">
            Create account
          </Link>
        </p>
      </div>
    </div>
  )
}
