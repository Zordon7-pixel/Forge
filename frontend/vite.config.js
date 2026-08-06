import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    manifest: 'asset-manifest.json',
  },
  server: {
    proxy: { '/api': 'http://localhost:4002' }
  }
})
