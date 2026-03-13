import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Activity, AlertTriangle, Brain, Dumbbell, Lock, Mountain, Ruler, Timer, Trophy } from 'lucide-react'
import api from '../lib/api'
import LoadingRunner from '../components/LoadingRunner'
import { useProContext } from '../context/ProContext'

function StatCard({ icon: Icon, label, value, sub }) {
  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 14,
        padding: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon size={16} color="#EAB308" />
        <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, textTransform: 'uppercase', letterSpacing: 0.7 }}>{label}</p>
      </div>
      <p style={{ fontSize: 24, fontWeight: 900, color: 'var(--text-primary)', marginTop: 8, lineHeight: 1 }}>{value}</p>
      {sub && <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{sub}</p>}
    </div>
  )
}

export default function WeeklyRecap() {
  const navigate = useNavigate()
  const { isPro, loading: proLoading } = useProContext()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.get('/recap/weekly')
      .then((res) => setData(res.data || null))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  const mileageDelta = Number(data?.mileageVsLastWeek || 0)
  const deltaLabel = mileageDelta >= 0 ? `+${mileageDelta}% vs last week` : `${mileageDelta}% vs last week`

  return (
    <div style={{ position: 'relative' }}>
      <div className="space-y-4" style={{ filter: !proLoading && !isPro ? 'blur(4px)' : 'none', pointerEvents: !proLoading && !isPro ? 'none' : 'auto' }}>
        {loading ? (
          <LoadingRunner message="Loading weekly recap" />
        ) : (
          <>
            <section className="rounded-2xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1.1, margin: 0 }}>Weekly AI Recap</p>
              <h1 style={{ fontSize: 28, fontWeight: 900, color: 'var(--text-primary)', margin: '8px 0 2px' }}>{data?.weekLabel || 'Last 7 days'}</h1>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>{deltaLabel}</p>
            </section>

            <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <StatCard icon={Ruler} label="Total Miles" value={Number(data?.totalMiles || 0).toFixed(1)} sub="Running is primary" />
              <StatCard icon={Activity} label="Runs" value={data?.totalRuns || 0} />
              <StatCard icon={Timer} label="Avg Pace" value={data?.avgPace ? `${data.avgPace}/mi` : '--'} />
              <StatCard icon={Dumbbell} label="Lift Sessions" value={data?.liftSessions || 0} sub="Injury prevention support" />
            </section>

            <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <StatCard icon={Mountain} label="Elevation Gain" value={`${Number(data?.totalElevationGain || 0).toLocaleString()} ft`} />
              <StatCard icon={Ruler} label="Longest Run" value={`${Number(data?.longestRun || 0).toFixed(1)} mi`} />
            </section>

            {Array.isArray(data?.prsThisWeek) && data.prsThisWeek.length > 0 && (
              <section className="rounded-2xl p-4" style={{ background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.32)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <Trophy size={16} color="#EAB308" />
                  <p style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)', margin: 0, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                    PRs Broken This Week
                  </p>
                </div>
                <div className="space-y-2">
                  {data.prsThisWeek.map((pr, idx) => (
                    <div key={`${pr}-${idx}`} className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                      <p style={{ fontSize: 13, color: 'var(--text-primary)', margin: 0, fontWeight: 700 }}>{pr}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {data?.injuryRiskFlag && (
              <section className="rounded-2xl p-4" style={{ background: 'rgba(249,115,22,0.14)', border: '1px solid rgba(249,115,22,0.4)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <AlertTriangle size={16} color="#F97316" />
                  <p style={{ fontSize: 12, fontWeight: 800, color: '#FDBA74', margin: 0, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                    Injury Risk Watch
                  </p>
                </div>
                <p style={{ marginTop: 8, marginBottom: 0, fontSize: 13, color: 'var(--text-primary)' }}>
                  {data?.injuryRiskReason || 'Training load is elevated this week. Keep the next run easy.'}
                </p>
              </section>
            )}

            <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderLeft: '4px solid #EAB308' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Brain size={16} color="#EAB308" />
                <p style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)', margin: 0, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                  AI Insight
                </p>
              </div>
              <p style={{ marginTop: 10, marginBottom: 0, fontSize: 14, lineHeight: 1.55, color: 'var(--text-primary)' }}>
                {data?.insight || 'Keep your next run easy and consistent to build aerobic fitness safely.'}
              </p>
            </section>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Link
                to="/"
                className="rounded-xl py-3 text-center text-sm font-bold"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)', textDecoration: 'none' }}
              >
                Back to Dashboard
              </Link>
              <Link
                to="/history"
                className="rounded-xl py-3 text-center text-sm font-bold"
                style={{ background: '#EAB308', color: '#000', textDecoration: 'none' }}
              >
                View History
              </Link>
            </div>
          </>
        )}
      </div>
      {!proLoading && !isPro && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backdropFilter: 'blur(4px)',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 16,
              padding: 32,
              textAlign: 'center',
              maxWidth: 320,
            }}
          >
            <Lock size={32} color="#EAB308" style={{ margin: '0 auto 12px' }} />
            <h3 style={{ color: 'var(--text-primary)', fontWeight: 800, fontSize: 20 }}>Weekly Recap</h3>
            <p style={{ color: 'var(--text-primary)', fontWeight: 700, marginTop: 8 }}>Weekly Recap is a Pro feature</p>
            <p style={{ color: 'var(--text-muted)', marginTop: 8 }}>Upgrade to see your weekly training insights and trends.</p>
            <button
              onClick={() => navigate('/upgrade')}
              style={{ background: '#EAB308', color: '#000', fontWeight: 700, padding: '12px 24px', borderRadius: 8, border: 'none', cursor: 'pointer', marginTop: 16 }}
            >
              Upgrade to Pro
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
