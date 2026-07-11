/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        accent: 'var(--accent)',
        'accent-dim': 'var(--accent-dim)',
        success: 'var(--success)',
        'success-dim': 'var(--success-dim)',
        warning: 'var(--warning)',
        'warning-dim': 'var(--warning-dim)',
        danger: 'var(--danger)',
        'danger-dim': 'var(--danger-dim)',
        'on-accent': 'var(--on-accent)',
        'bg-base': 'var(--bg-base)',
        'bg-card': 'var(--bg-card)',
        'bg-input': 'var(--bg-input)',
        'text-primary': 'var(--text-primary)',
        'text-muted': 'var(--text-muted)',
        'border-subtle': 'var(--border-subtle)',
        'card-border-strong': 'var(--card-border-strong)',
        'chart-axis': 'var(--chart-axis)',
        'chart-grid': 'var(--chart-grid)',
      }
    }
  },
  plugins: [],
}
