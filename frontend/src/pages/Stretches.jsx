import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { postRunStretches, preRunStretches } from '../data/stretches'

export default function Stretches() {
  const [mode, setMode] = useState('pre')

  const stretches = useMemo(() => (mode === 'pre' ? preRunStretches : postRunStretches), [mode])
  const isPre = mode === 'pre'

  return (
    <div className="bg-[#0f1117] min-h-screen rounded-2xl p-4 text-white">
      <header className="mb-4">
        <h1 className="text-2xl font-bold">Stretch Library</h1>
        <p className="text-sm text-slate-400">Pre & post-run routines built for runners.</p>
      </header>

      <div className="mb-4 rounded-xl bg-[#151823] p-2 flex gap-2">
        <button
          onClick={() => setMode('pre')}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${isPre ? 'bg-yellow-500 text-black' : 'bg-[#1c2130] text-slate-300'}`}
        >
          Pre-Run Warmup
        </button>
        <button
          onClick={() => setMode('post')}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${!isPre ? 'bg-yellow-500 text-black' : 'bg-[#1c2130] text-slate-300'}`}
        >
          Post-Run Recovery
        </button>
      </div>

      <div className="mb-20 grid grid-cols-2 gap-3">
        {stretches.map(stretch => (
          <article key={stretch.id} className="rounded-xl border border-[#2a2d3e] bg-[#151823] p-3">
            <div className="mb-2 flex flex-wrap items-center gap-1 text-[10px]">
              <span className="rounded-full bg-slate-700 px-2 py-0.5 text-slate-200">{stretch.muscle}</span>
              <span className={`rounded-full px-2 py-0.5 ${stretch.type === 'dynamic' ? 'bg-emerald-900 text-emerald-300' : 'bg-indigo-900 text-indigo-300'}`}>
                {stretch.type === 'dynamic' ? 'Dynamic' : 'Static'}
              </span>
            </div>
            <h2 className="text-sm font-bold text-white">{stretch.name}</h2>
            <p className="mt-1 text-xs text-slate-400">{stretch.duration}s • {stretch.reps}</p>
            <p
              className="mt-2 text-xs text-slate-400"
              style={{
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical'
              }}
            >
              {stretch.cue}
            </p>
            <button
              onClick={() => window.open(stretch.videoUrl, '_blank', 'noopener,noreferrer')}
              className="mt-3 rounded-lg border border-[#2a2d3e] px-2 py-1 text-xs text-slate-300"
            >
              ▶ Watch
            </button>
          </article>
        ))}
      </div>

      <div className="fixed bottom-16 left-1/2 z-20 w-full max-w-[480px] -translate-x-1/2 px-4">
        <Link
          to={`/stretches/session?type=${isPre ? 'pre' : 'post'}`}
          className="block w-full rounded-xl bg-yellow-500 px-4 py-3 text-center text-sm font-black text-black"
        >
          {isPre ? 'Start Warmup →' : 'Start Recovery →'}
        </Link>
      </div>
    </div>
  )
}
