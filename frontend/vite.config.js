import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:4002' }
  },
  build: {
    // Disable crossorigin attribute on script/link tags
    // Prevents CORS issues when served from same-origin Express server
    modulePreload: {
      polyfill: false
    },
    rollupOptions: {
      output: {
        // Keep assets in /assets/ folder
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
      }
    }
  }
})
