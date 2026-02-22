/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        accent: 'var(--accent)',
        'accent-dim': 'var(--accent-dim)',
        'bg-base': 'var(--bg-base)',
        'bg-card': 'var(--bg-card)',
        'bg-input': 'var(--bg-input)',
        'text-primary': 'var(--text-primary)',
        'text-muted': 'var(--text-muted)',
        'border-subtle': 'var(--border-subtle)',
      }
    }
  },
  plugins: [],
}
