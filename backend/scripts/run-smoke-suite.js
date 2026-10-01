const fs = require('node:fs');
const { spawnSync, execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const routePositive = ['backend/test/adaptiveCoachingCalendar.smoke.js', ['--route-positive']];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function discoverFiles(backendRoot = root) {
  return fs.readdirSync(path.join(backendRoot, 'test')).filter(file => file.endsWith('.smoke.js')).sort().concat('concurrentPlan.test.js');
}
function basePlan(files) {
  return files.flatMap(file => (file === 'racePlanQuality.smoke.js' ? [[], ['--semantic-acceptance']] : [[]])
    .map(args => [`backend/test/${file}`, args]));
}
// Default local behavior deliberately retains the original labels, order,
// inherited environment, synchronous execution and first-failure exit.
function runDefault({ backendRoot = root, files = discoverFiles(backendRoot), spawn = spawnSync, log = console.log } = {}) {
  for (const [file, args] of basePlan(files)) {
    log(`\n[backend smoke] ${path.basename(file)}${args.length ? ' --semantic-acceptance' : ''}`);
    const result = spawn(process.execPath, [path.join(backendRoot, 'test', path.basename(file)), ...args], { cwd: backendRoot, stdio: 'inherit' });
    if (result.status !== 0) return result.status || 1;
  }
  log(`\nBACKEND SMOKE SUITE OK (${files.length} files)`);
  return 0;
}
function parseArgs(argv) {
  if (!argv.length) return { mode: 'local' };
  const options = new Map();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--ci-shard-index', '--ci-shard-count', '--ci-route-positive', '--receipt'].includes(key) || options.has(key)) throw Error('Invalid CI smoke argument');
    if (key === '--ci-route-positive') options.set(key, true);
    else {
      const value = argv[++i];
      if (typeof value !== 'string' || !value.length || value.startsWith('--')) throw Error('Missing CI smoke argument');
      options.set(key, value);
    }
  }
  const receipt = options.get('--receipt');
  if (!receipt || receipt.includes('\0')) throw Error('Missing receipt path');
  if (options.has('--ci-route-positive')) {
    if (options.size !== 2) throw Error('Conflicting CI smoke modes');
    return { mode: 'route-positive', shard_index: null, shard_count: 4, receipt };
  }
  const index = options.get('--ci-shard-index'), count = options.get('--ci-shard-count');
  if (options.size !== 3 || !/^[0-3]$/.test(index ?? '') || count !== '4') throw Error('Invalid CI shard assignment');
  return { mode: 'base', shard_index: Number(index), shard_count: 4, receipt };
}
function deriveContext(repo, eventRevision, { git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }) } = {}) {
  const checkout = git(['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(eventRevision ?? '') || checkout !== eventRevision) throw Error('CI event/checkout revision mismatch');
  const tracked = git(['ls-files', '-z', '--', 'backend/test']).split('\0').filter(Boolean);
  const files = discoverFiles(path.join(repo, 'backend'));
  const found = files.filter(f => f.endsWith('.smoke.js')).map(f => `backend/test/${f}`);
  const trackedSmoke = tracked.filter(f => /^backend\/test\/[^/]+\.smoke\.js$/.test(f)).sort();
  if (JSON.stringify(found) !== JSON.stringify(trackedSmoke)) throw Error('Tracked/discovered smoke inventory mismatch');
  for (const file of [...found, 'backend/test/concurrentPlan.test.js', routePositive[0], 'backend/test/racePlanQuality.smoke.js']) {
    if (!tracked.includes(file) || !fs.lstatSync(path.join(repo, file)).isFile()) throw Error('Required tracked regular test missing');
  }
  const base = basePlan(files), full = [...base, routePositive];
  return { repo, base, full, event_revision: eventRevision, checkout_revision: checkout,
    backend_lock_sha256: hash(fs.readFileSync(path.join(repo, 'backend/package-lock.json'))),
    frontend_lock_sha256: hash(fs.readFileSync(path.join(repo, 'frontend/package-lock.json'))),
    inventory_hash: hash(JSON.stringify(full) + '\n') };
}
function assignment(context, options) {
  return options.mode === 'route-positive' ? [routePositive] : context.base.filter((_, i) => i % 4 === options.shard_index);
}
function atomicReceipt(destination, receipt) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function runCI(context, options, { spawn = spawnSync, log = console.log, now = Date.now } = {}) {
  const destination = path.resolve(options.receipt);
  // Initial atomic write proves the location writable before any child starts.
  // Never reuse a receipt from another attempt, even at the same revision.
  if (fs.existsSync(destination) || !fs.statSync(path.dirname(destination)).isDirectory()) throw Error('Receipt destination must be a new file in an existing directory');
  const expected = assignment(context, options);
  const receipt = { schema_version: 'forge-backend-smoke-receipt-v1', event_revision: context.event_revision,
    checkout_revision: context.checkout_revision, backend_lock_sha256: context.backend_lock_sha256,
    frontend_lock_sha256: context.frontend_lock_sha256, inventory_hash: context.inventory_hash,
    assignment_algorithm: 'sorted-base-index-modulo-4-v1', mode: options.mode,
    shard_index: options.shard_index, shard_count: 4, expected, executed: [], succeeded: [], terminal: { state: 'RUNNING', exit: null } };
  atomicReceipt(destination, receipt);
  for (const [ordinal, identity] of expected.entries()) {
    const start = now();
    log(`\n[backend smoke] ${path.basename(identity[0])}${identity[1].length ? ' ' + identity[1].join(' ') : ''}`);
    let result;
    try { result = spawn(process.execPath, [path.join(context.repo, identity[0]), ...identity[1]], { cwd: path.join(context.repo, 'backend'), stdio: 'inherit' }); }
    catch { result = { status: 1, signal: null }; }
    const finish = now(), signal = typeof result.signal === 'string' && result.signal ? result.signal : null;
    const exit = Number.isInteger(result.status) && result.status >= 0 ? result.status : signal ? null : 1;
    receipt.executed.push({ identity, ordinal, started_at: new Date(start).toISOString(), finished_at: new Date(finish).toISOString(), elapsed_ms: finish - start, exit, signal });
    if (exit === 0 && signal === null) receipt.succeeded.push(identity);
    else receipt.terminal = { state: 'FAILED', exit: exit || 1 };
    atomicReceipt(destination, receipt);
    if (receipt.terminal.state === 'FAILED') return receipt.terminal.exit;
  }
  receipt.terminal = { state: 'COMPLETE', exit: 0 };
  atomicReceipt(destination, receipt);
  log(`\nBACKEND CI SMOKE OK (${expected.length} invocations; ${options.mode}${options.mode === 'base' ? ' ' + options.shard_index + '/4' : ''})`);
  return 0;
}
function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.mode === 'local') return runDefault();
  return runCI(deriveContext(path.dirname(root), process.env.GITHUB_SHA), options);
}
module.exports = { discoverFiles, basePlan, runDefault, parseArgs, deriveContext, assignment, atomicReceipt, runCI, main };
if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { console.error('BACKEND CI SMOKE FAILED:', error.message); process.exitCode = 1; }
}
