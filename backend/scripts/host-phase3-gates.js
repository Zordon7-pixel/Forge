// Run from repository root on the supported Node22 host toolchain.
// No deployments, production requests, or model calls. Every gate must exit zero.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const dir = path.join(root, '.qa/phase3');
fs.mkdirSync(dir, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sha = git('rev-parse', 'HEAD');
const status = git('status', '--porcelain', '--untracked-files=no');
if (status) throw new Error('Commit the scoped candidate before exact-tip host gates.');
const report = { sha, node: process.version, started_at: new Date().toISOString(), completed: false, pass: false, gates: [] };
const save = () => fs.writeFileSync(path.join(dir, 'host-gates.json'), JSON.stringify(report, null, 2) + '\n');
save();
const commands = [
  ['witnesses', process.execPath, ['backend/test/adaptiveOnApply.smoke.js']],
  ['on-core', process.execPath, ['backend/test/adaptiveCoachingOnGate.smoke.js']],
  ['preview', process.execPath, ['backend/test/adaptiveCoachingPreview.smoke.js']],
  ['review-ui', process.execPath, ['frontend/test/planCandidateReview.smoke.mjs']],
  ['full-qa', 'npm', ['run', 'qa']],
  ['diff-check', 'git', ['diff', '--check']],
];
for (const [name, command, args] of commands) {
  const logfile = path.join(dir, `${name}.log`);
  const fd = fs.openSync(logfile, 'w');
  const start = Date.now();
  console.log(`START ${name} ${sha}`);
  const result = spawnSync(command, args, { cwd: root, stdio: ['ignore', fd, fd],
    env: { ...process.env, FORGE_PHASE3_WITNESS_DIR: dir } });
  fs.closeSync(fd);
  report.gates.push({ name, command: [command, ...args].join(' '), exit_code: result.status,
    signal: result.signal, error: result.error?.message || null, duration_ms: Date.now() - start, log: logfile });
  save();
  console.log(`END ${name} exit=${result.status}`);
  if (result.status !== 0) { report.completed = true; report.finished_at = new Date().toISOString(); save(); process.exit(1); }
}
report.final_sha = git('rev-parse', 'HEAD');
report.tracked_clean = !git('status', '--porcelain', '--untracked-files=no');
report.completed = true;
report.pass = report.final_sha === sha && report.tracked_clean;
report.finished_at = new Date().toISOString();
save();
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exit(1);
