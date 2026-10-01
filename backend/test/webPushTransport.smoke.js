'use strict';
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const { createECDH, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
const webpush = require('web-push');
const { createWebPushTransport, validateEndpoint, publicAddress, expiredEndpoint, DEADLINE_MS } = require('../src/services/webPushTransport');

const vapidDetails = { ...webpush.generateVAPIDKeys(), subject: 'mailto:synthetic@example.invalid' };
const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
const subscription = { endpoint: 'https://fcm.googleapis.com/send/opaque-secret?cap=secret',
  keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
const payload = JSON.stringify({ title: 'Forge update', body: 'Open Forge to review.' });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ a = ['8.8.8.8'], aaaa = [], status = 201, chunks = [], hang, resolverError, requestError } = {}) {
  const seen = { resolutions: [], requests: [], cancels: 0, destroyed: 0, responseDestroyed: 0, pending: [] };
  const resolverFactory = () => ({
    resolve4(host, cb) { seen.resolutions.push([4,host]); if (hang === 'dns') seen.pending.push(() => cb(null,a)); else queueMicrotask(() => cb(resolverError,a)); },
    resolve6(host, cb) { seen.resolutions.push([6,host]); if (hang === 'dns') seen.pending.push(() => cb(null,aaaa)); else queueMicrotask(() => cb(null,aaaa)); },
    cancel() { seen.cancels++; },
  });
  const request = (options, cb) => {
    seen.requests.push(options);
    const req = new EventEmitter();
    req.destroy = () => { seen.destroyed++; };
    req.end = body => {
      seen.body = body;
      if (requestError) { queueMicrotask(() => req.emit('error', requestError)); return; }
      if (hang === 'connect') return;
      queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = status;
        response.destroy = () => { seen.responseDestroyed++; };
        seen.response = response; cb(response);
        for (const chunk of chunks) response.emit('data', chunk);
        if (hang !== 'body') response.emit('end');
      });
    };
    return req;
  };
  return { seen, resolverFactory, request };
}
function fakeClock() {
  let time = 0, serial = 0;
  const timers = new Map();
  return { now: () => time, schedule: (fn,ms) => { const id=++serial; timers.set(id,{fn,ms}); return id; },
    unschedule: id => timers.delete(id), timers,
    advance(ms) { time += ms; const callbacks=[...timers.values()]; timers.clear(); for (const item of callbacks) item.fn(); } };
}
async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code); assert.equal(error.message,code);
    const serialized = JSON.stringify(error) + error.stack;
    for (const secret of ['opaque-secret','cap=secret',vapidDetails.privateKey,subscription.keys.auth,payload,'sensitive-response']) {
      assert(!serialized.includes(secret));
    }
    return true;
  });
}

async function main() {
  // Independent boundary table covering the union of both complete IANA
  // special-purpose registries (2025-10-09), including reachable exceptions.
  // Parent ranges intentionally cover their more-specific registry entries.
  const excludedBoundaries=[
    ['0.0.0.0','0.255.255.255'],['10.0.0.0','10.255.255.255'],['100.64.0.0','100.127.255.255'],
    ['127.0.0.0','127.255.255.255'],['169.254.0.0','169.254.255.255'],['172.16.0.0','172.31.255.255'],
    ['192.0.0.0','192.0.0.255'],['192.0.2.0','192.0.2.255'],['192.31.196.0','192.31.196.255'],
    ['192.52.193.0','192.52.193.255'],['192.88.99.0','192.88.99.255'],['192.168.0.0','192.168.255.255'],
    ['192.175.48.0','192.175.48.255'],['198.18.0.0','198.19.255.255'],['198.51.100.0','198.51.100.255'],
    ['203.0.113.0','203.0.113.255'],['240.0.0.0','255.255.255.255'],
    ['::','::'],['::1','::1'],['::ffff:0:0','::ffff:ffff:ffff'],
    ['64:ff9b::','64:ff9b::ffff:ffff'],['64:ff9b:1::','64:ff9b:1:ffff:ffff:ffff:ffff:ffff'],
    ['100::','100::ffff:ffff:ffff:ffff'],['100:0:0:1::','100:0:0:1:ffff:ffff:ffff:ffff'],
    ['2001::','2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff'],['2001:db8::','2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2002::','2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],['2620:4f:8000::','2620:4f:8000:ffff:ffff:ffff:ffff:ffff'],
    ['3fff::','3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff'],['5f00::','5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['fc00::','fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],['fe80::','febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ];
  for(const range of excludedBoundaries) for(const address of range) {
    assert.equal(publicAddress(address),false,`excluded boundary ${address}`);
    // A safe A answer cannot authorize an unsafe A or AAAA answer, in either order.
    for(const safeFirst of [true,false]) {
      const config=address.includes(':')?{a:['8.8.8.8'],aaaa:safeFirst?['2606:4700:4700::1111',address]:[address,'2606:4700:4700::1111']}
        :{a:safeFirst?['8.8.8.8',address]:[address,'8.8.8.8']};
      const f=fixture(config);await rejectsCode(createWebPushTransport(f)(subscription,payload,{vapidDetails}),'WEB_PUSH_DNS_UNSAFE');
      assert.equal(f.seen.requests.length,0,`no IO for mixed boundary ${address}`);assert.equal(f.seen.cancels,1);
    }
  }
  for(const address of ['192.31.195.255','192.31.197.0','192.52.192.255','192.52.194.0','192.175.47.255','192.175.49.0',
    '2620:4f:7fff:ffff:ffff:ffff:ffff:ffff','2620:4f:8001::']) assert.equal(publicAddress(address),true,`outside new exclusion ${address}`);
  for (const endpoint of ['https://fcm.googleapis.com/a/../B%2f?q=%2F', 'https://FCM.GOOGLEAPIS.COM?A=1',
    'https://updates.push.services.mozilla.com/wpush/v2/a', 'https://web.push.apple.com/a', 'https://a.b.push.apple.com/q']) {
    const validated=validateEndpoint(endpoint); assert.equal(validated.endpoint,endpoint);
    assert.equal(validated.path, endpoint.replace(/^https:\/\/[^/?]+/,'').replace(/^(?!\/)/,'/'));
  }
  for (const endpoint of [null,'','http://fcm.googleapis.com/a','HTTPS://fcm.googleapis.com/a',
    ' https://fcm.googleapis.com/a','https://fcm.googleapis.com/a\n','https://fcm.googleapis.com\\x',
    'https://user@fcm.googleapis.com/a','https://fcm.googleapis.com:443/a','https://fcm.googleapis.com:/a',
    'https://fcm.googleapis.com./a','https://%66cm.googleapis.com/a','https://127.0.0.1/a','https://[::1]/a',
    'https://fcm.googleapis.com/a#x','https://fcm.googleapis.com/%q1','https://fcm.googleapis.com/%',
    'https://fcm.googleapis.com/é','https://push.apple.com/a','https://evilpush.apple.com/a',
    'https://a.push.apple.com.attacker.test/a','https://xn--a.push.apple.com/a','https://-a.push.apple.com/a',
    `https://${'a'.repeat(64)}.push.apple.com/a`,`https://fcm.googleapis.com/${'a'.repeat(2048)}`]) {
    assert.throws(() => validateEndpoint(endpoint), /WEB_PUSH_ENDPOINT_INVALID/);
  }
  for (const address of ['0.0.0.0','10.1.2.3','100.64.1.2','127.0.0.1','169.254.169.254','172.16.0.1','192.168.0.1',
    '192.0.0.9','192.0.2.1','192.88.99.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255',
    '::','::1','::ffff:8.8.8.8','::ffff:127.0.0.1','64:ff9b::808:808','fc00::1','fe80::1','ff02::1',
    '2001:db8::1','2001::1','2002:808:808::1','3fff::1','5f00::1','2001:4860::1%en0','garbage']) assert.equal(publicAddress(address),false,address);
  for (const address of ['8.8.8.8','1.1.1.1','17.188.170.1','2001:4860:4860::8888','2606:4700:4700::1111']) assert.equal(publicAddress(address),true,address);
  for (const config of [{a:[]},{a:['8.8.8.8','127.0.0.1']},{aaaa:['::ffff:8.8.8.8']},{aaaa:['fe80::1']},{a:Array(65).fill('8.8.8.8')}]) {
    const f=fixture(config); await rejectsCode(createWebPushTransport(f)(subscription,payload,{vapidDetails}),'WEB_PUSH_DNS_UNSAFE');
    assert.equal(f.seen.requests.length,0); assert.equal(f.seen.cancels,1);
  }
  const invalidDns=fixture({resolverError: new Error('sensitive-response')});
  await rejectsCode(createWebPushTransport(invalidDns)(subscription,payload,{vapidDetails}),'WEB_PUSH_DNS_FAILED');
  const ok=fixture();
  const oldProxy = { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY, ALL_PROXY: process.env.ALL_PROXY };
  try {
    process.env.HTTPS_PROXY=process.env.HTTP_PROXY=process.env.ALL_PROXY='http://127.0.0.1:1/secret';
    assert.deepEqual(await createWebPushTransport(ok)(subscription,payload,{vapidDetails}),{statusCode:201});
  } finally { for (const [key,value] of Object.entries(oldProxy)) { if(value===undefined)delete process.env[key];else process.env[key]=value; } }
  assert.equal(ok.seen.requests.length,1); assert.equal(ok.seen.resolutions.length,2);
  const options=ok.seen.requests[0];
  assert.equal(options.path,'/send/opaque-secret?cap=secret'); assert.equal(options.servername,'fcm.googleapis.com');
  assert.equal(options.rejectUnauthorized,true); assert.equal(options.checkServerIdentity,tls.checkServerIdentity);
  assert.equal(options.agent.keepAlive,false); assert.deepEqual(options.agent.options.proxyEnv,{});
  assert.equal(options.headers['Content-Encoding'],'aes128gcm'); assert.match(options.headers.Authorization,/^vapid /);
  assert(Buffer.isBuffer(ok.seen.body)); assert(!ok.seen.body.includes(Buffer.from(payload)));
  for (let i=0;i<3;i++) options.lookup('fcm.googleapis.com',{all:true},(err,addresses)=>{
    assert.equal(err,null);assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]);
  });
  assert.equal(ok.seen.resolutions.length,2,'pinned socket lookup never re-resolves, even after DNS changes');
  options.lookup('other.example',{},err=>assert.equal(err.code,'WEB_PUSH_DNS_UNSAFE'));
  assert.equal(ok.seen.cancels,1); assert.equal(ok.seen.destroyed,1); assert.equal(ok.seen.responseDestroyed,1);
  for (const endpoint of ['https://updates.push.services.mozilla.com/wpush/a','https://web.push.apple.com/q']) {
    const f=fixture({a:[],aaaa:['2606:4700:4700::1111']});
    await createWebPushTransport(f)({...subscription,endpoint},payload,{vapidDetails});
    f.seen.requests[0].lookup(validateEndpoint(endpoint).host,{},(err,address,family)=>{
      assert.equal(err,null);assert.equal(address,'2606:4700:4700::1111');assert.equal(family,6);
    });
  }
  for (const status of [301,302,307,401,403,404,410,429,500]) {
    const f=fixture({status,chunks:['sensitive-response']});
    await assert.rejects(createWebPushTransport(f)(subscription,payload,{vapidDetails}), error=>{
      assert.equal(error.code,`WEB_PUSH_HTTP_${status}`);assert.equal(expiredEndpoint(error),status===404||status===410);
      assert(!JSON.stringify(error).includes('sensitive-response'));return true;
    });
    assert.equal(f.seen.requests.length,1,'no redirect or retry');
  }
  assert.equal(expiredEndpoint({statusCode:410}),false,'caller status is not trusted transport evidence');
  const big=fixture({chunks:[Buffer.alloc(8192),Buffer.alloc(1)]});
  await rejectsCode(createWebPushTransport(big)(subscription,payload,{vapidDetails}),'WEB_PUSH_RESPONSE_TOO_LARGE');
  assert(big.seen.destroyed && big.seen.responseDestroyed);
  await createWebPushTransport(fixture({chunks:[Buffer.alloc(8192)]}))(subscription,payload,{vapidDetails});
  await rejectsCode(createWebPushTransport(fixture())({...subscription,keys:{auth:'secret',p256dh:'bad'}},payload,{vapidDetails}),'WEB_PUSH_REQUEST_INVALID');
  await rejectsCode(createWebPushTransport(fixture())(subscription,payload),'WEB_PUSH_REQUEST_INVALID');
  for (const hang of ['dns','connect','body','owner']) {
    const f=fixture({hang}), clock=fakeClock(), controller=new AbortController();
    const send=createWebPushTransport({...f,...clock});
    const promise=send(subscription,payload,{vapidDetails,signal:controller.signal,
      ...(hang==='owner'?{beforeSend:()=>new Promise(()=>{})}:{})});
    const rejection=rejectsCode(promise,'WEB_PUSH_TIMEOUT'); await tick();
    clock.advance(7999); await tick();assert.equal(clock.timers.size,1,'early timer cannot shorten deadline');
    clock.advance(1); await rejection;assert.equal(clock.timers.size,0);assert.equal(f.seen.cancels,1);
    assert.equal(getEventListeners(controller.signal,'abort').length,0);
    for(const callback of f.seen.pending)callback();await tick();
    if(hang==='dns'||hang==='owner')assert.equal(f.seen.requests.length,0,'late work cannot send');
    if(hang==='connect'||hang==='body')assert(f.seen.destroyed);
  }
  for(const hang of ['dns','connect','body']) {
    const f=fixture({hang}),clock=fakeClock(),controller=new AbortController();
    const p=createWebPushTransport({...f,...clock})(subscription,payload,{vapidDetails,signal:controller.signal});
    const checked=rejectsCode(p,'WEB_PUSH_ABORTED');await tick();controller.abort();await checked;
    assert.equal(getEventListeners(controller.signal,'abort').length,0);
    assert.equal(clock.timers.size,0);assert.equal(f.seen.cancels,1);for(const callback of f.seen.pending)callback();await tick();
  }
  const stale=fixture(); await rejectsCode(createWebPushTransport(stale)(subscription,payload,{vapidDetails,beforeSend:async()=>false}),'WEB_PUSH_TARGET_STALE');
  assert.equal(stale.seen.requests.length,0);
  const network=fixture({requestError:new Error('sensitive-response opaque-secret')});
  await rejectsCode(createWebPushTransport(network)(subscription,payload,{vapidDetails}),'WEB_PUSH_NETWORK_FAILED');
  const truncated=fixture({status:410,hang:'body'});
  const incomplete=createWebPushTransport(truncated)(subscription,payload,{vapidDetails});
  const incompleteCheck=rejectsCode(incomplete,'WEB_PUSH_NETWORK_FAILED');await tick();truncated.seen.response.emit('aborted');await incompleteCheck;
  const preAborted=new AbortController();preAborted.abort();const unused=fixture();
  await rejectsCode(createWebPushTransport(unused)(subscription,payload,{vapidDetails,signal:preAborted.signal}),'WEB_PUSH_ABORTED');
  assert.equal(unused.seen.resolutions.length,0);
  // One real wall-clock whole-operation deadline, separate from the deterministic phase matrix.
  const hanging=fixture({hang:'dns'}), began=performance.now();
  await rejectsCode(createWebPushTransport(hanging)(subscription,payload,{vapidDetails}),'WEB_PUSH_TIMEOUT');
  const elapsed=performance.now()-began;assert(elapsed>=8000 && elapsed<12000,`real absolute deadline ${elapsed}`);
  for(const callback of hanging.seen.pending)callback();await tick();assert.equal(hanging.seen.requests.length,0);

  // Real TLS and encrypted HTTP over loopback only. No provider DNS/socket is contacted.
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'forge-push-tls-'));
  let server;
  try {
    process.env.HTTPS_PROXY=process.env.HTTP_PROXY=process.env.ALL_PROXY='http://127.0.0.1:1/secret';
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=fcm.googleapis.com',
      '-addext','subjectAltName=DNS:fcm.googleapis.com','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem')],{stdio:'ignore'});
    const key=fs.readFileSync(path.join(dir,'key.pem')),cert=fs.readFileSync(path.join(dir,'cert.pem'));
    let hits=0, wirePath, sni;
    server=https.createServer({key,cert},(req,res)=>{hits++;wirePath=req.url;sni=req.socket.servername;req.resume();req.on('end',()=>{res.writeHead(201);res.end('sensitive-response');});});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=server.address().port;
    const localRequest=(opts,cb)=>{
      opts.agent.createConnection=(socketOptions)=>{
        opts.lookup(opts.hostname,{all:true},(err,records)=>{assert.equal(err,null);assert.equal(records[0].address,'8.8.8.8');});
        return tls.connect({...socketOptions,host:'127.0.0.1',port,lookup:undefined,ca:cert});
      };
      return https.request(opts,cb);
    };
    const sender=createWebPushTransport({...fixture(),request:localRequest});
    await sender({...subscription,endpoint:'https://fcm.googleapis.com/a/../B%2f?q=%2F'},payload,{vapidDetails});
    assert.equal(hits,1);assert.equal(wirePath,'/a/../B%2f?q=%2F');assert.equal(sni,'fcm.googleapis.com');
    await rejectsCode(sender({...subscription,endpoint:'https://updates.push.services.mozilla.com/a'},payload,{vapidDetails}),'WEB_PUSH_NETWORK_FAILED');
    assert.equal(hits,1,'hostname mismatch fails before HTTP');
    const untrusted=createWebPushTransport({...fixture(),request:(opts,cb)=>{
      opts.agent.createConnection=socketOptions=>tls.connect({...socketOptions,host:'127.0.0.1',port,lookup:undefined});
      return https.request(opts,cb);
    }});
    await rejectsCode(untrusted(subscription,payload,{vapidDetails}),'WEB_PUSH_NETWORK_FAILED');assert.equal(hits,1);
  } finally {
    for(const [key,value] of Object.entries(oldProxy)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});
  }
  assert.equal(DEADLINE_MS,8000);
  console.log('WEB PUSH TRANSPORT OK: URL/DNS/pinning/real TLS/crypto/deadline/body/abort/redaction; synthetic only');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
