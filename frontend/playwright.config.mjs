import { defineConfig } from '@playwright/test'

const portValue = process.env.FORGE_E2E_PORT ?? '5197'
if (!/^[1-9]\d{0,4}$/.test(portValue) || Number(portValue) > 65535) {
  throw new Error('FORGE_E2E_PORT must be an integer TCP port from 1 to 65535 (no whitespace or leading zeros)')
}
const port = Number(portValue)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './test/e2e',
  testMatch: ['coreJourneys.spec.mjs', 'authenticatedJourneys.spec.mjs', 'dashboardWeeklyRecap.spec.mjs', 'coachTakeaways.spec.mjs', 'runNearMe.spec.mjs'],
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
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
