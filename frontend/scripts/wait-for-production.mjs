const baseUrl = String(process.env.FORGE_QA_BASE_URL || 'https://forge-production-773f.up.railway.app').replace(/\/$/, '')
const timeoutMs = Number(process.env.FORGE_QA_TIMEOUT_MS || 600_000)
const expectedAssetPath = String(process.env.FORGE_QA_EXPECTED_ASSET || '').trim()
const expectedRevision = String(process.env.FORGE_QA_EXPECTED_REVISION || '').trim().toLowerCase()
const deadline = Date.now() + timeoutMs
let attempt = 0
let lastError = null

if (expectedAssetPath && !/^\/assets\/[A-Za-z0-9_.-]+\.js$/.test(expectedAssetPath)) {
  throw new Error(`FORGE_QA_EXPECTED_ASSET is invalid: ${expectedAssetPath}`)
}
if (expectedRevision && !/^[a-f0-9]{40}$/.test(expectedRevision)) {
  throw new Error(`FORGE_QA_EXPECTED_REVISION is invalid: ${expectedRevision}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function probe() {
  const shellResponse = await fetch(`${baseUrl}/?forge_qa=${Date.now()}`, { cache: 'no-store' })
  if (shellResponse.status !== 200) throw new Error(`shell returned ${shellResponse.status}`)
  const deployedRevision = String(shellResponse.headers.get('x-forge-revision') || '').trim().toLowerCase()
  if (expectedRevision && deployedRevision !== expectedRevision) {
    throw new Error(`shell serves revision ${deployedRevision || 'missing'}; waiting for ${expectedRevision}`)
  }
  if (expectedRevision) {
    const releaseMode = String(shellResponse.headers.get('x-forge-goal-backward-mode') || '').trim()
    const releaseAudience = String(shellResponse.headers.get('x-forge-goal-backward-audience') || '').trim()
    if (releaseMode !== 'on' || releaseAudience !== 'all') {
      throw new Error(`shell serves goal-backward ${releaseMode || 'missing'}/${releaseAudience || 'missing'}; waiting for on/all`)
    }
  }
  const shell = await shellResponse.text()
  const assetPath = shell.match(/<script[^>]+src="([^"]+\.js)"/)?.[1]
  if (!assetPath) throw new Error('shell did not expose a hashed JavaScript asset')
  if (expectedAssetPath && assetPath !== expectedAssetPath) {
    throw new Error(`shell serves ${assetPath}; waiting for ${expectedAssetPath}`)
  }

  const assetResponse = await fetch(new URL(expectedAssetPath || assetPath, baseUrl), { cache: 'no-store' })
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
