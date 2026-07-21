export const chartAxisProps = {
  stroke: 'var(--chart-axis)',
  tick: { fill: 'var(--chart-axis)', fontSize: 10 },
  tickLine: { stroke: 'var(--chart-grid)' },
  axisLine: { stroke: 'var(--chart-grid)' },
}

export const chartTooltipProps = {
  contentStyle: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 12,
    color: 'var(--text-primary)',
  },
  labelStyle: { color: 'var(--text-muted)' },
  itemStyle: { color: 'var(--text-primary)' },
}

export const chartAccent = 'var(--accent)'
export const chartContrast = 'var(--text-primary)'

export function isUsableChartValue(value) {
  if (value === null || value === undefined || value === '') return false
  return Number.isFinite(typeof value === 'number' ? value : Number(value))
}

export function hasUsableChartData(data, dataKey) {
  if (!Array.isArray(data) || !dataKey) return false
  return data.some((point) => point && isUsableChartValue(point[dataKey]))
}
