import { expect } from '@playwright/test'

export async function waitForHistoryReady(page) {
  // History renders its h1 only after auth, the lazy route and its initial load.
  // This is independent of the run-detail/Coach Takeaways surface under test.
  // Use the existing expect budget; the overall test deadline is unchanged.
  await expect(page.locator('main').getByRole('heading', {
    name: 'History', level: 1, exact: true,
  })).toBeVisible()
}

export async function waitForPlanCatalogSavedRacesReady(page) {
  // Only for journeys seeded with upcoming saved races. The authenticated shell
  // and route heading can render before /races completes; this select is mounted
  // only after those initial data become usable. It says nothing about planner
  // copy, prefill (loaded after selection), or generation success.
  const main = page.locator('main')
  await expect(main).toBeVisible()
  const savedRaces = main.getByRole('combobox', { name: 'Use a saved race', exact: true })
  await expect(savedRaces).toBeVisible()
  await expect(savedRaces).toBeEnabled()
}
