// Deterministic harness regressions; no server, database/repository/planner mock,
// browser, external request or existing cluster. Explicitly invoked, not auto-smoke.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { artifactDir, socketAllowed, installSocketGuard, bounded, cleanupSteps, runGuarded, assertStoredPlanWeeks } = require('./raceSearch.integration');

runGuarded('harness-regression', async () => {
  // Use the installed pg JSONB parser (OID 3802), without a DB replacement.
  const plan = { weeks: [{ week_number: 1, days: [{ date: '2027-01-01' }] }] };
  const serialized = JSON.stringify(plan);
  const decoded = require('pg').types.getTypeParser(3802, 'text')(serialized);
  assert.deepEqual(assertStoredPlanWeeks({ plan_data: decoded }), plan);
  assert.equal(assertStoredPlanWeeks({ plan_data: decoded }), decoded);
  assert.deepEqual(assertStoredPlanWeeks({ plan_data: serialized }), plan);
  for (const invalid of [undefined, null, {}, [], 0, true, { weeks: [] }, { weeks: 'wrong' }, { weeks: { length: 1 } }]) {
    assert.throws(() => assertStoredPlanWeeks({ plan_data: invalid }));
    if (invalid !== undefined) assert.throws(() => assertStoredPlanWeeks({ plan_data: JSON.stringify(invalid) }));
  }
  assert.throws(() => assertStoredPlanWeeks(null));
  assert.throws(() => assertStoredPlanWeeks({ plan_data: '{bad json' }));
  console.log('PASS actual pg JSONB decode and serialized rows; missing/malformed/empty calendars rejected');

  const dir = '/nonexistent-race-qa-' + randomUUID();
  const socket = dir + '/.s.PGSQL.55481';
  for (const args of [[socket,undefined],[socket,()=>{}],[{path:socket}],[[{path:socket},()=>{}]],
    [43210,'127.0.0.1'],['43210','127.0.0.1'],[{host:'127.0.0.1',port:43210}],[{host:'127.0.0.1',port:43210,path:null}],[[{host:'127.0.0.1',port:43210},()=>{}]]]) {
    assert.equal(socketAllowed(args,dir),true,JSON.stringify(args));
  }
  for (const args of [['/tmp/other/.s.PGSQL.55481'],[socket+'/other'],[{path:dir+'/../other',host:'127.0.0.1'}],
    [443,'example.invalid'],[{host:'example.invalid',port:443}],[[{host:'localhost',port:43210}]],
    [43210],[{host:'127.0.0.1',port:0}],['https://example.invalid']]) assert.equal(socketAllowed(args,dir),false,JSON.stringify(args));
  console.log('PASS pg pathname, normalized net.connect and loopback TCP signatures; foreign paths/hosts denied');

  // The actual installed pg pool must settle rejected connects and pool.end().
  // This proves the native async error contract, without an external connection.
  const { Pool } = require('pg');
  let denied = 0;
  const guard = installSocketGuard(dir, () => denied++);
  try {
    for (const [host,expected] of [[dir,/ENOENT/],['example.invalid',/EXTERNAL_NETWORK_FORBIDDEN/]]) {
      const pool = new Pool({host,port:55481,user:'synthetic',database:'synthetic',connectionTimeoutMillis:500});
      try { await assert.rejects(bounded('real pg rejected connect',()=>pool.query('SELECT 1'),1500),expected); }
      finally { await bounded('real pg rejected pool.end',()=>pool.end(),1500); }
    }
    assert.equal(denied,1);
  } finally { guard.restore(); }
  console.log('PASS real pg string socket reaches native ENOENT; forbidden connect rejects asynchronously and both pools drain');

  const cleanupOrder = [];
  await assert.rejects(cleanupSteps([
    ['deliberately unsettled cleanup',()=>new Promise(()=>{}),20],
    ['later cleanup still runs',()=>cleanupOrder.push('later')],
  ]),/Harness cleanup failed/);
  assert.deepEqual(cleanupOrder,['later']);

  const harness = require.resolve('./raceSearch.integration');
  for (const scenario of ['success','unsettled','assertion','cleanup','early-exit']) {
    const evidence = fs.mkdtempSync(path.join(artifactDir(),`guard-${scenario}-`));
    const program = `
      const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
      const {runGuarded}=require(${JSON.stringify(harness)});
      const scenario=${JSON.stringify(scenario)};
      runGuarded('negative-control',async()=>{
        if(scenario==='early-exit')process.exit(0);
        if(scenario==='unsettled')await new Promise(()=>{});
        assert.notEqual(scenario,'assertion','deliberate assertion failure');
        fs.writeFileSync(path.join(process.env.RACE_QA_ARTIFACT_DIR,'assertions-done'),'yes');
      },{timeoutMs:30,cleanup:async()=>{
        fs.writeFileSync(path.join(process.env.RACE_QA_ARTIFACT_DIR,'cleanup-attempted'),'yes');
        assert.notEqual(scenario,'cleanup','deliberate cleanup failure');
      }}).catch(error=>{console.error(error.message);process.exitCode=1});`;
    const child = spawnSync(process.execPath,['-e',program],{encoding:'utf8',env:{...process.env,RACE_QA_ARTIFACT_DIR:evidence}});
    fs.writeFileSync(path.join(evidence,'child.log'),child.stdout+child.stderr);
    assert.equal(child.status,scenario==='success'?0:1,scenario);
    const files = fs.readdirSync(evidence).filter(file=>file.endsWith('-receipt.json'));
    assert.equal(files.length,1);
    const receipt = JSON.parse(fs.readFileSync(path.join(evidence,files[0])));
    assert.equal(receipt.status,scenario==='success'?'completed':'failed',scenario);
    if(scenario!=='early-exit')assert.ok(fs.existsSync(path.join(evidence,'cleanup-attempted')));
    if(scenario==='unsettled')assert.match(receipt.error,/timed out/);
    if(scenario==='success')assert.ok(fs.existsSync(path.join(evidence,'assertions-done')));
  }
  console.log('PASS five subprocess receipt controls: success, unsettled promise, assertion, cleanup and premature exit; no empty false green');
}).catch(error=>{console.error(error);process.exitCode=1});
