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
