import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useUnits } from '../context/UnitsContext'
import {
  ArrowUpRight,
  ArrowDownRight,
  Flame,
  Trophy,
  Zap,
  Timer,
  Activity,
  Target,
  Calendar,
  TrendingUp,
} from 'lucide-react'
import api from '../lib/api'
import LoadingRunner from '../components/LoadingRunner'

function StatCard({ icon: Icon, label, value, sub, accent }) {
  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 16,
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Icon size={16} color={accent || '#EAB308'} />
        <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
          {label}
        </span>
      </div>
      <p style={{ fontSize: 28, fontWeight: 900, color: 'var(--text-primary)', lineHeight: 1 }}>{value}</p>
      {sub && <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</p>}
    </div>
  )
}

export default function WeeklyRecap() {
  const { t } = useTranslation()
  const { fmt } = useUnits()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('week')

  useEffect(() => {
    const endpoint = tab === 'week' ? '/recap/weekly' : '/recap/monthly'
    setLoading(true)
    api
      .get(endpoint)
      .then(res => setData(res.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [tab])

  if (loading) return <LoadingRunner message={t('recap.loading', 'Loading recap')} />

  const vsChange = data?.vsLastWeek
  const vsPositive = vsChange && vsChange.miles >= 0

  const monthlyPct = data?.monthlyGoal
    ? Math.min(100, Math.round((data.monthlyMiles / data.monthlyGoal) * 100))
    : 0

  return (
    <div style={{ paddingBottom: 32 }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 26, fontWeight: 900, color: 'var(--text-primary)', margin: 0 }}>
          {t('recap.title', 'Weekly Recap')}
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
          {tab === 'week' ? t('recap.thisWeek', 'This Week') : t('recap.thisMonth', 'This Month')}
        </p>
      </div>

      {/* Tab toggle */}
      <div
        style={{
          display: 'flex',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: 4,
          marginBottom: 20,
          gap: 4,
        }}
      >
        {[['week', t('recap.weekly', 'Weekly')], ['month', t('recap.monthly', 'Monthly')]].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              flex: 1,
              padding: '8px 0',
              borderRadius: 9,
              border: 'none',
              cursor: 'pointer',
              fontWeight: 700,
              fontSize: 13,
              background: tab === key ? '#EAB308' : 'transparent',
              color: tab === key ? '#000' : 'var(--text-muted)',
              transition: 'all 0.15s',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Hero: total miles */}
      <div
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 20,
          padding: '24px 20px',
          marginBottom: 16,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: -20,
            right: -20,
            width: 120,
            height: 120,
            borderRadius: '50%',
            background: 'rgba(234,179,8,0.08)',
          }}
        />
        <p
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: 1.5,
            marginBottom: 6,
          }}
        >
          {t('recap.totalMiles', 'Total Miles')}
        </p>
        <p style={{ fontSize: 56, fontWeight: 900, color: 'var(--text-primary)', lineHeight: 1, margin: 0 }}>
          {fmt.distanceValue(data?.totalMiles || 0).toFixed(1)}
        </p>
        <p style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 4 }}>
          {fmt.distanceLabel}
        </p>

        {/* vs last period */}
        {vsChange && vsChange.pct !== null && (
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              marginTop: 12,
              background: vsPositive ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
              borderRadius: 8,
              padding: '4px 10px',
            }}
          >
            {vsPositive ? (
              <ArrowUpRight size={14} color="#22c55e" />
            ) : (
              <ArrowDownRight size={14} color="#ef4444" />
            )}
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: vsPositive ? '#22c55e' : '#ef4444',
              }}
            >
              {vsPositive ? '+' : ''}
              {vsChange.pct}% {t('recap.vsLastWeek', 'vs last week')}
            </span>
          </div>
        )}
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <StatCard
          icon={Activity}
          label={t('recap.totalRuns', 'Runs')}
          value={data?.totalRuns ?? 0}
          sub={t('recap.runsThisWeek', 'this period')}
        />
        <StatCard
          icon={Zap}
          label={t('recap.totalWorkouts', 'Workouts')}
          value={data?.totalWorkouts ?? 0}
          sub={t('recap.workoutsThisWeek', 'strength sessions')}
        />
        <StatCard
          icon={Timer}
          label={t('recap.activeMinutes', 'Active Time')}
          value={
            (data?.totalMinutes || 0) >= 60
              ? `${Math.floor((data?.totalMinutes || 0) / 60)}h ${(data?.totalMinutes || 0) % 60}m`
              : `${data?.totalMinutes || 0}m`
          }
          sub={t('recap.combined', 'runs + lifts')}
        />
        <StatCard
          icon={Flame}
          label={t('calories.burned', 'Calories')}
          value={(data?.totalCalories || 0).toLocaleString()}
          sub={t('calories.burned', 'cal burned')}
          accent="#EAB308"
        />
      </div>

      {/* Avg Pace */}
      {data?.avgPace && (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 16,
            padding: '16px 20px',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <TrendingUp size={18} color="#EAB308" />
            <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>{t('recap.avgPace', 'Avg Pace')}</p>
          </div>
          <p style={{ fontSize: 20, fontWeight: 900, color: 'var(--text-primary)', margin: 0 }}>
            {data.avgPace} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>/mi</span>
          </p>
        </div>
      )}

      {/* Best run */}
      {data?.bestRun && (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderLeft: '4px solid #EAB308',
            borderRadius: 16,
            padding: '16px 20px',
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Trophy size={16} color="#EAB308" />
            <p
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: 1,
                margin: 0,
              }}
            >
              {t('recap.bestRun', 'Best Run')}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 24 }}>
            <div>
              <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)', margin: 0 }}>
                {fmt.distanceValue(data.bestRun.miles).toFixed(2)}
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmt.distanceLabel}</p>
            </div>
            {data.bestRun.pace && (
              <div>
                <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)', margin: 0 }}>
                  {data.bestRun.pace}
                </p>
                <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>/mi pace</p>
              </div>
            )}
            {data.bestRun.date && (
              <div>
                <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-muted)', margin: 0 }}>
                  {new Date(data.bestRun.date + 'T12:00:00').toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                  })}
                </p>
                <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('recap.date', 'date')}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Streak callout */}
      {data?.streak > 0 && (
        <div
          style={{
            background: 'rgba(234,179,8,0.08)',
            border: '1px solid rgba(234,179,8,0.3)',
            borderRadius: 16,
            padding: '14px 18px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 16,
          }}
        >
          <Flame size={22} color="#EAB308" />
          <div>
            <p style={{ fontSize: 18, fontWeight: 900, color: '#EAB308', margin: 0 }}>
              {data.streak} {t('recap.streakDays', 'day streak')}
            </p>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
              {t('recap.keepItUp', 'Keep the momentum going')}
            </p>
          </div>
        </div>
      )}

      {/* Monthly miles progress bar */}
      {tab === 'week' && data?.monthlyMiles !== undefined && (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 16,
            padding: '16px 20px',
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Target size={16} color="#EAB308" />
              <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                {t('recap.monthlyProgress', 'Monthly Progress')}
              </p>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
              {fmt.distanceValue(data.monthlyMiles).toFixed(1)} / {fmt.distanceValue(data.monthlyGoal || 50).toFixed(0)} {fmt.distanceLabel}
            </p>
          </div>
          <div
            style={{
              width: '100%',
              height: 10,
              borderRadius: 6,
              background: 'var(--bg-base)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${monthlyPct}%`,
                borderRadius: 6,
                background: monthlyPct >= 100 ? '#22c55e' : '#EAB308',
                transition: 'width 0.6s ease',
              }}
            />
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>{monthlyPct}% {t('recap.ofMonthlyGoal', 'of monthly goal')}</p>
        </div>
      )}

      {/* No data state */}
      {!data?.totalRuns && !data?.totalWorkouts && (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 16,
            padding: '32px 20px',
            textAlign: 'center',
            marginBottom: 16,
          }}
        >
          <Calendar size={32} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
          <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
            {t('recap.noData', 'No activity this period yet')}
          </p>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
            {t('recap.logToSee', 'Log a run or workout to see your recap')}
          </p>
        </div>
      )}

      {/* Navigation */}
      <Link
        to="/history"
        style={{
          display: 'block',
          width: '100%',
          padding: '14px 0',
          borderRadius: 14,
          textAlign: 'center',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-subtle)',
          color: 'var(--text-muted)',
          fontWeight: 600,
          fontSize: 14,
          textDecoration: 'none',
        }}
      >
        {t('recap.viewHistory', 'View Full History')}
      </Link>
    </div>
  )
}
