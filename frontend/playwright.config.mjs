import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test/e2e',
  testMatch: ['coreJourneys.spec.mjs', 'authenticatedJourneys.spec.mjs', 'dashboardWeeklyRecap.spec.mjs'],
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL: 'http://127.0.0.1:5197',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 5197',
    url: 'http://127.0.0.1:5197',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'compact-mobile-320',
      use: { viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    },
    {
      name: 'iphone-17',
      use: { viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    },
  ],
})
