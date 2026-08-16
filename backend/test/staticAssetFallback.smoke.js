const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function runStaticAssetFallbackSmoke() {
  const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const plansSource = fs.readFileSync(path.join(__dirname, '../src/routes/plans.js'), 'utf8');
  const railwaySource = fs.readFileSync(path.join(__dirname, '../../railway.toml'), 'utf8');

  const assetFallbackIndex = appSource.indexOf("app.get('/assets/*'");
  const spaFallbackIndex = appSource.indexOf("app.get('*'");

  assert.ok(assetFallbackIndex >= 0, 'missing /assets files have an explicit fallback');
  assert.ok(spaFallbackIndex > assetFallbackIndex, 'asset 404 is registered before the SPA fallback');
  assert.match(
    appSource.slice(assetFallbackIndex, spaFallbackIndex),
    /status\(404\).*type\('text\/plain'\)/s,
    'missing assets return a plain-text 404 instead of index.html'
  );
  assert.match(
    appSource,
    /process\.env\.RAILWAY_GIT_COMMIT_SHA[\s\S]*res\.set\('X-Forge-Revision', deploymentRevision\)/,
    'Railway responses expose the exact deployed Git revision for release-bound QA'
  );
  assert.match(
    appSource,
    /getGoalBackwardV24Mode\(\)[\s\S]*getGoalBackwardV24Audience\(\)[\s\S]*res\.set\('X-Forge-Goal-Backward-Mode', goalBackwardReleaseMode\)[\s\S]*res\.set\('X-Forge-Goal-Backward-Audience', goalBackwardReleaseAudience\)/,
    'normal responses expose only closed normalized goal-backward release identity values'
  );
  assert.match(
    railwaySource,
    /startCommand = "cd backend && node src\/db\/seed\.js; FORGE_GOAL_BACKWARD_V24_MODE=on FORGE_GOAL_BACKWARD_V24_AUDIENCE=all FORGE_GOAL_BACKWARD_V24_EXPECTED_REVISION=\$RAILWAY_GIT_COMMIT_SHA node src\/app\.js"/,
    'Railway preserves seed/app ordering and starts the backend with public exact-revision activation'
  );
  assert.match(
    railwaySource,
    /restartPolicyType = "always"/,
    'Railway retains the existing always-restart policy'
  );
  assert.match(
    plansSource,
    /function resolvePlanGoalBackwardV24Mode[\s\S]*audience: dependencies\.audience/,
    'plan mode resolution accepts an injectable release audience'
  );
  assert.match(
    plansSource,
    /previewPlanForUser[\s\S]*resolvePlanGoalBackwardV24Mode\(userId, goalBackwardDependencies[\s\S]*applyPlanCandidate[\s\S]*resolvePlanGoalBackwardV24Mode\(userId, runtimeDependencies\)/,
    'preview and apply resolve through the same injected audience decision'
  );
  assert.match(
    appSource,
    /app\.use\('\/api',[\s\S]*res\.vary\('Authorization'\)/,
    'authenticated API responses vary by Authorization before service-worker caching'
  );

  console.log('STATIC ASSET AND RELEASE STARTUP CONTRACT SMOKE OK');
}

if (require.main === module) runStaticAssetFallbackSmoke();

module.exports = { runStaticAssetFallbackSmoke };
