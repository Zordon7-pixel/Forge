import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { HeartPulse, Shield } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import Skeleton from '../components/Skeleton'

function trendMeta(trend) {
  if (trend === 'up') return { arrow: '↑', color: 'var(--success)' }
  if (trend === 'down') return { arrow: '↓', color: 'var(--danger)' }
  return { arrow: '→', color: 'var(--text-muted)' }
}

function DriverCard({ driver, trendLabels }) {
  const trend = trendMeta(driver.trend)
  return (
    <article className="card p-4">
      <p className="t-micro">{driver.label}</p>
      <div className="mt-2 flex items-end gap-2">
        <p className="stat-num" style={{ color: 'var(--text-primary)', fontSize: 24, lineHeight: 1.1 }}>{driver.value}</p>
        <span className="pb-1 text-lg font-black" style={{ color: trend.color }} aria-label={trendLabels[driver.trend] || trendLabels.flat}>
          {trend.arrow}
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{driver.plainEnglish}</p>
      <p className="mt-3 text-xs italic" style={{ color: driver.impact === 'negative' ? 'var(--warning)' : 'var(--text-muted)' }}>{driver.suggestion}</p>
    </article>
  )
}

export default function HealthData() {
  const { t } = useTranslation()
  const [driversData, setDriversData] = useState(null)
  const [readinessHistory, setReadinessHistory] = useState([])
  const [loading, setLoading] = useState(true)

  const loadData = async () => {
    setLoading(true)
    try {
      const [driversRes, readinessRes] = await Promise.all([
        api.get('/body/drivers').catch(() => ({ data: null })),
        api.get('/recovery/readiness/history?days=14').catch(() => ({ data: null })),
      ])
      setDriversData(driversRes.data || { summary: t('body.allGood'), limiter: null, drivers: [] })
      setReadinessHistory(Array.isArray(readinessRes.data?.days) ? readinessRes.data.days : [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  const drivers = Array.isArray(driversData?.drivers) ? driversData.drivers : []
  const trendLabels = { up: t('body.trendUp'), down: t('body.trendDown'), flat: t('body.trendFlat') }

  return (
    <div className="space-y-4 pb-16">
      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>Body</h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>Recovery trends and the signals worth acting on.</p>
          </div>
          <Shield size={22} color="var(--accent)" />
        </div>
      </section>

      {loading && <Skeleton rows={2} />}

      {readinessHistory.length > 0 && (
        <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>Readiness history</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>Recent recovery trend; missing days stay missing.</p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {readinessHistory.map((entry) => (
              <div key={entry.date} className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                <p className="text-[10px] font-bold uppercase" style={{ color: 'var(--text-muted)' }}>{entry.date}</p>
                <p className="mt-1 text-xl font-black" style={{ color: 'var(--text-primary)' }}>{entry.score}</p>
                <p className="text-[10px] font-bold" style={{ color: entry.band === 'GREEN' ? 'var(--success)' : entry.band === 'RED' ? 'var(--danger)' : 'var(--warning)' }}>{entry.band}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {drivers.length === 0 && !loading ? (
        <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <HeartPulse size={28} color="var(--accent)" style={{ marginBottom: 12 }} />
          <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('body.noData')}</p>
          <Link
            to="/more"
            className="mt-3 inline-flex rounded-xl px-4 py-2 text-sm font-black"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)', textDecoration: 'none' }}
          >
            {t('body.noDataCta')}
          </Link>
        </section>
      ) : (
        <section>
          <h2 className="mb-3 text-sm font-black" style={{ color: 'var(--text-primary)' }}>What may affect today</h2>
          <div className="grid grid-cols-2 gap-3">
            {drivers.map((driver) => (
              <DriverCard key={driver.key} driver={driver} trendLabels={trendLabels} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
