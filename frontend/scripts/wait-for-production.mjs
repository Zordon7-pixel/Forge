const baseUrl = String(process.env.FORGE_QA_BASE_URL || 'https://forge-production-773f.up.railway.app').replace(/\/$/, '')
const timeoutMs = Number(process.env.FORGE_QA_TIMEOUT_MS || 600_000)
const deadline = Date.now() + timeoutMs
let attempt = 0
let lastError = null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function probe() {
  const shellResponse = await fetch(`${baseUrl}/?forge_qa=${Date.now()}`, { cache: 'no-store' })
  if (shellResponse.status !== 200) throw new Error(`shell returned ${shellResponse.status}`)
  const shell = await shellResponse.text()
  const assetPath = shell.match(/<script[^>]+src="([^"]+\.js)"/)?.[1]
  if (!assetPath) throw new Error('shell did not expose a hashed JavaScript asset')

  const assetResponse = await fetch(new URL(assetPath, baseUrl), { cache: 'no-store' })
  const assetType = assetResponse.headers.get('content-type') || ''
  if (assetResponse.status !== 200 || !/javascript|ecmascript/i.test(assetType)) {
    throw new Error(`hashed asset returned ${assetResponse.status} ${assetType}`)
  }

  const staleResponse = await fetch(`${baseUrl}/assets/forge-stale-chunk-probe.js?forge_qa=${Date.now()}`, { cache: 'no-store' })
  const staleType = staleResponse.headers.get('content-type') || ''
  if (staleResponse.status !== 404 || /text\/html/i.test(staleType)) {
    throw new Error(`stale asset returned ${staleResponse.status} ${staleType}`)
  }

  return assetPath
}

while (Date.now() < deadline) {
  attempt += 1
  try {
    const assetPath = await probe()
    console.log(`PRODUCTION SHELL READY (${attempt} attempts, ${assetPath})`)
    process.exit(0)
  } catch (error) {
    lastError = error
    console.log(`[production-wait] attempt ${attempt}: ${error.message}`)
    await sleep(10_000)
  }
}

console.error(`Production did not become ready within ${timeoutMs}ms: ${lastError?.message || 'unknown error'}`)
process.exit(1)
