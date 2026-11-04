// Executes the actual production functions, without importing React or duplicating
// date conversion. Also imported by the backend test to supply UI-generated weeks.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

export function loadTrainUntilHelper(DateClass = Date) {
  const source = readFileSync(new URL('../src/pages/PlanCatalog.jsx', import.meta.url), 'utf8')
  const names = ['localTodayISO', 'isValidISODate', 'trainUntilDuration']
  const functions = names.map(name => {
    const start = source.indexOf(`function ${name}(`)
    assert.ok(start >= 0, `production function ${name}`)
    const end = source.indexOf('\n}', start) + 2
    return source.slice(start, end)
  }).join('\n')
  return vm.runInNewContext(`${functions}\ntrainUntilDuration`, { Date: DateClass })
}

export function runUnitTests() {
  let assertions = 0
  const priorTZ = process.env.TZ
  try {
    for (const timezone of ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/Berlin', 'Pacific/Kiritimati', 'Pacific/Honolulu']) {
      process.env.TZ = timezone
      for (const start of ['2026-02-20', '2026-10-15', '2028-02-01']) {
        const RealDate = Date
        class FixedDate extends RealDate {
          constructor(...args) { super(...(args.length ? args : [`${start}T23:59:00`])) }
        }
        const convert = loadTrainUntilHelper(FixedDate)
        for (let days = -2; days <= 142; days++) {
          const end = new Date(Date.parse(`${start}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
          const result = convert(end)
          if (days >= 22 && days <= 140) {
            assert.equal(result.weeks, Math.ceil(days / 7), `${timezone} ${start} +${days}`)
            assert.equal(result.error, '')
          } else {
            assert.equal(result.weeks, null)
            assert.ok(result.error)
          }
          assertions += 2
        }
      }
    }
    const convert = loadTrainUntilHelper()
    for (const value of ['2027-02-29', '2028-02-30', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '11/30/2026', '2026-1-30', '2026-12-01T00:00:00Z', 'bad']) {
      assert.equal(convert(value, '2026-11-01').weeks, null)
      assert.match(convert(value, '2026-11-01').error, /valid/)
      assertions += 2
    }
    assert.equal(convert('2028-02-29', '2028-02-01').weeks, 4)
    assert.equal(convert('', '2026-11-01').weeks, null)
    assert.equal(convert('', '2026-11-01').error, '')
    // A sheet kept open overnight must be revalidated at submission.
    assert.equal(convert('2026-11-23', '2026-11-01').weeks, 4)
    assert.ok(convert('2026-11-23', '2026-11-02').error)
    console.log(`PASS production Train until helper: ${assertions + 5} assertions; boundaries 21/22/28/29/140/141 days, partial weeks, DST, local dates, six timezones, leap days, rollover`)
  } finally {
    if (priorTZ === undefined) delete process.env.TZ
    else process.env.TZ = priorTZ
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) runUnitTests()
