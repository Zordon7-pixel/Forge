import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test/e2e',
  testMatch: 'productionShell.spec.mjs',
  fullyParallel: false,
  retries: 1,
  workers: 1,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  timeout: 60_000,
  use: {
    baseURL: process.env.FORGE_QA_BASE_URL || 'https://forge-production-773f.up.railway.app',
    serviceWorkers: 'allow',
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
})
