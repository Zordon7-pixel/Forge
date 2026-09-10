// Explicit local browser integration gate. Input is a sanitized real disposable
// HTTP acceptance receipt, not a production account or a manufactured plan.
// The API transport is intercepted; backend persistence is proved separately by
// activityPersistence.integration.js. Run against a freshly built local preview.
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { createQaToken, installAuthenticatedApi, qaResponse, setQaBrowserClock } from './e2e/support/mockApi.mjs'

const receiptPath = process.argv[2]
assert.match(receiptPath || '', /^\/tmp\/forge_program_test_[a-f0-9]+-useful-recovery-accepted-program\.json$/)
const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
for (const body of [receipt.parent, receipt.parent_today, receipt.current, receipt.today]) {
  assert.equal(body?.surface_manifest?.status, 'accepted', 'Both before/after calendar and Today must be real accepted HTTP receipts')
}
assert.equal(receipt.applied.status, 'accepted')
assert.equal(receipt.current.plan.plan_data.weeks.length, receipt.parent.plan.plan_data.weeks.length)
assert.ok(receipt.preview.changes.some(change => change.before.workout_family === 'long_aerobic' && change.after.workout_family === 'recovery_run'))
assert.ok(receipt.preview.changes.some(change => change.before.kind === 'lift' && change.after.workout_family === 'rest'))
const baseURL = 'http://127.0.0.1:5197'
const browser = await chromium.launch()
const myResponse = body => ({ ...body, user_plan: { id: body.plan.user_plan_id,
  plan_id: body.plan.plan_id, current_week: body.plan.current_week, started_at: body.plan.started_at,
  plan_version: body.plan.plan_version, progress: typeof body.plan.progress_json === 'string'
    ? JSON.parse(body.plan.progress_json) : body.plan.progress_json } })
try {
  for (const width of [320, 393]) {
    const context = await browser.newContext({ viewport: { width, height: width === 320 ? 568 : 874 },
      timezoneId: 'America/New_York', serviceWorkers: 'block', isMobile: true, hasTouch: true })
    const page = await context.newPage()
    await setQaBrowserClock(page, receipt.preview.planningDate)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let committed = false, attempts = 0
    const preview = { ...receipt.preview, observationTicket: 'intercepted-local-browser-protocol-placeholder' }
    const state = await installAuthenticatedApi(page, { user: { id: receipt.current.plan.user_id },
      token: createQaToken({ id: receipt.current.plan.user_id,
        exp: Math.floor(new Date(`${receipt.preview.planningDate}T12:00:00Z`).getTime() / 1000) + 86400 }), responses: [
      ['GET /api/plans/my', () => myResponse(committed ? receipt.current : receipt.parent)],
      ['GET /api/plans/current', () => committed ? receipt.current : receipt.parent],
      ['GET /api/plans/today', () => committed ? receipt.today : receipt.parent_today],
      ['GET /api/plans/adaptation/current', () => ({ proposal: committed ? null : preview })],
      ['POST /api/plans/adaptation/preview/accept', entry => {
        assert.equal(entry.body.observation_ticket, preview.observationTicket)
        assert.equal(entry.body.preview_fingerprint, preview.previewFingerprint)
        assert.equal(entry.body.proposal_revision, preview.revision)
        assert.equal(entry.body.proposal_plan_version, preview.planVersion)
        if (++attempts === 1) return qaResponse({ queued: true, offline: true }, 202)
        committed = true
        return receipt.applied
      }],
    ] })
    await page.goto(`${baseURL}/plan`)
    await expect(page.getByText('Week 1 of 5', { exact: true })).toBeVisible()
    const panel = page.getByRole('button', { name: new RegExp(preview.headline) })
    await expect(panel).toBeVisible()
    if (await panel.getAttribute('aria-expanded') !== 'true') await panel.click()
    for (const change of preview.changes) await expect(page.getByText(change.summary, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(page.getByText(/Forge did not save this choice immediately/)).toBeVisible()
    assert.equal(committed, false)
    await expect(page.getByText('Accepted. Calendar updated.', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0)
    assert.equal(committed, true)
    await expect(page.getByText('Week 1 of 5', { exact: true })).toBeVisible()
    const sunday = page.getByRole('button', { name: /^Sun 13 / })
    await expect(sunday).toContainText('Recovery run')
    await expect(sunday).not.toContainText('Long run')
    await expect(sunday.getByText('Long', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('group', { name: 'Weekly training target' })).not.toContainText('1 long')
    for (let index = 2; index <= 5; index++) {
      await page.getByRole('button', { name: 'Next week', exact: true }).click()
      await expect(page.getByText(`Week ${index} of 5`, { exact: true })).toBeVisible()
    }
    await expect(page.getByRole('button', { name: 'Next week', exact: true })).toBeDisabled()
    await page.reload()
    await expect(page.getByText(/Week \d of 5/, { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Sun 13 / })).toContainText('Recovery run')
    const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }))
    assert.ok(layout.width <= layout.viewport + 1, JSON.stringify(layout))
    assert.deepEqual(errors, [])
    assert.deepEqual(state.unexpectedRequests, [])
    await page.screenshot({ path: `/tmp/forge-activity-accepted-mobile-${width}.png`, fullPage: true })
    console.log(JSON.stringify({ gate: 'activity-acceptance-browser', width, status: 'PASS', receiptPath,
      apiMode: 'intercepted-real-HTTP-receipt', acceptedReload: true, fullHorizon: 5, offlineFalseSuccess: false }))
    await context.close()
  }
} finally { await browser.close() }
