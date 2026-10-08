// Real upgraded dependencies, real Forge mail/auth routes, synthetic loopback only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const nodemailer = require('nodemailer');
const { Address4, Address6 } = require('ip-address');
const rateLimit = require('express-rate-limit');
const express = require('express');
const bcrypt = require('bcryptjs');
const deadline = setTimeout(() => { console.error('Mail/IP compatibility deadline exceeded'); process.exit(1); }, 20000);
const servers = [], sockets = new Set();
async function listen(server) { servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
const originalCreateTransport = nodemailer.createTransport;
const originalFetch = global.fetch;
const originalEnv = { ...process.env };
const mailPath = require.resolve('../src/services/mail');
function freshMail() { delete require.cache[mailPath]; return require(mailPath); }
async function main() {
  assert.equal(require('nodemailer/package.json').version, '10.0.13');
  assert.equal(require('ip-address/package.json').version, '10.7.1');
  assert.deepEqual(Object.keys(nodemailer).sort(), ['createTestAccount', 'createTransport', 'getTestMessageUrl']);
  let mode = 'ok', messages = [], data = '', authSeen = 0;
  const smtp = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    if (mode === 'greeting-drop') { socket.destroy(); return; }
    socket.write('220 localhost synthetic SMTP\r\n'); let buffered = '', inData = false;
    socket.on('data', chunk => {
      buffered += chunk.toString();
      while (buffered.includes('\r\n')) {
        const i = buffered.indexOf('\r\n'), line = buffered.slice(0, i); buffered = buffered.slice(i + 2);
        if (inData) {
          if (line === '.') { messages.push(data); data = ''; inData = false; socket.write('250 accepted locally\r\n'); }
          else data += line + '\r\n';
        } else if (/^EHLO/.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/.test(line)) { authSeen++; assert.equal(Buffer.from(line.split(' ')[2], 'base64').toString(), '\0synthetic\0not-a-secret'); socket.write(mode === 'auth-fail' ? '535 rejected\r\n' : '235 authenticated\r\n'); }
        else if (/^DATA/.test(line)) { if (mode === 'send-drop') socket.destroy(); else { inData = true; socket.write('354 data\r\n'); } }
        else if (/^QUIT/.test(line)) { socket.end('221 bye\r\n'); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  const port = await listen(smtp);
  Object.assign(process.env, { APP_URL: 'https://forge.example.invalid', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'synthetic', SMTP_PASS: 'not-a-secret', SMTP_SECURE: 'false', EMAIL_FROM: 'Forge <from@example.invalid>', JWT_SECRET: 'synthetic-security-compatibility' });
  let optionsSeen, composed;
  nodemailer.createTransport = options => {
    optionsSeen = options;
    const t = originalCreateTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const send = t.sendMail.bind(t); t.sendMail = async value => { composed = await send(value); return composed; }; return t;
  };
  await freshMail().sendPasswordResetEmail({ to: 'athlete@example.invalid', token: 'a&b' });
  assert.equal(optionsSeen.host, '127.0.0.1'); assert.equal(optionsSeen.connectionTimeout, 10000); assert.equal(optionsSeen.socketTimeout, 15000);
  assert.deepEqual(optionsSeen.auth, { user: 'synthetic', pass: 'not-a-secret' });
  assert.deepEqual(composed.envelope.to, ['athlete@example.invalid']);
  const mime = composed.message.toString();
  assert.match(mime, /Subject: Reset your Forge password/); assert.match(mime, /token=3Da%26b|token=a%26b/); assert.match(mime, /text\/html/); assert.match(mime, /text\/plain/);
  nodemailer.createTransport = originalCreateTransport;
  let mail = freshMail(); await mail.sendPasswordResetEmail({ to: 'athlete@example.invalid', token: 'synthetic' });
  assert.equal(messages.length, 1); assert.equal(authSeen, 1);
  const t = originalCreateTransport({ host: '127.0.0.1', port, secure: false, auth: { user: 'synthetic', pass: 'not-a-secret' }, connectionTimeout: 500, greetingTimeout: 500, socketTimeout: 500 });
  await new Promise((resolve, reject) => t.sendMail({ from: 'from@example.invalid', to: 'to@example.invalid', text: 'callback synthetic' }, (e, result) => { if (e) reject(e); else { assert.deepEqual(result.accepted, ['to@example.invalid']); resolve(); } }));
  for (const failure of ['auth-fail', 'greeting-drop', 'send-drop']) {
    mode = failure; await assert.rejects(mail.sendPasswordResetEmail({ to: 'athlete@example.invalid', token: 'synthetic' }));
  }
  mode = 'auth-fail';
  await new Promise((resolve, reject) => t.sendMail({ from: 'from@example.invalid', to: 'to@example.invalid', text: 'synthetic rejection' }, error => {
    try { assert.equal(error?.code, 'EAUTH'); resolve(); } catch (e) { reject(e); }
  }));
  mode = 'ok';
  // Actual password-reset routes and stored records; only DB dialect shim replaces PostgreSQL syntax.
  const fixture = require('./helpers/adaptiveShadowDb').createDb({ syntheticProfileFields: false });
  const db = fixture.db;
  const startup = fs.readFileSync(path.join(__dirname, '../src/db/index.js'), 'utf8');
  db.exec(startup.match(/CREATE TABLE IF NOT EXISTS password_reset_tokens \([\s\S]*?\n\s*\);/)[0]);
  db.prepare("INSERT INTO users(id,name,email,password_hash) VALUES('a','Synthetic','athlete@example.invalid',?),('b','Other','other@example.invalid',?)").run(bcrypt.hashSync('old-secret', 4), bcrypt.hashSync('other-secret', 4));
  const realMutation = fixture.exports.withUserMutation;
  fixture.exports.withUserMutation = (owner, fn) => realMutation(owner, async tx => {
    if (!await tx.get('SELECT id FROM users WHERE id=?', [owner])) { const e = Error('deleted synthetic account'); e.code = 'AUTH_ACCOUNT_DELETED'; throw e; }
    return fn(tx);
  });
  const dbPath = require.resolve('../src/db'); require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
  const app = express(); app.use(express.json()); app.use('/auth', require('../src/routes/auth'));
  app.set('trust proxy', 1);
  app.get('/limited', rateLimit({ windowMs: 60000, limit: 2, standardHeaders: true, legacyHeaders: false }), (_req, res) => res.json({ ok: true }));
  app.get('/user-limited', rateLimit({ windowMs: 60000, limit: 1, keyGenerator: req => req.headers['x-synthetic-user'] }), (_req, res) => res.json({ ok: true }));
  const httpPort = await listen(require('node:http').createServer(app));
  const base = `http://127.0.0.1:${httpPort}`;
  global.fetch = (url, options) => { assert.equal(new URL(url).origin, base, 'no external HTTP'); return originalFetch(url, options); };
  const post = async (route, body) => { const r = await fetch(`${base}/auth/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  assert.equal((await post('forgot-password', { email: 'bad' })).status, 400);
  const unknown = await post('forgot-password', { email: 'missing@example.invalid' });
  const known = await post('forgot-password', { email: 'athlete@example.invalid' }); assert.deepEqual(known, unknown);
  const record = db.prepare("SELECT * FROM password_reset_tokens WHERE user_id='a'").get(); assert.ok(record.token);
  const otherHash = db.prepare("SELECT password_hash FROM users WHERE id='b'").get().password_hash;
  assert.equal((await post('reset-password', { token: record.token, password: 'new-secret' })).status, 200);
  assert.ok(bcrypt.compareSync('new-secret', db.prepare("SELECT password_hash FROM users WHERE id='a'").get().password_hash));
  assert.equal(db.prepare("SELECT password_hash FROM users WHERE id='b'").get().password_hash, otherHash);
  assert.equal((await post('reset-password', { token: record.token, password: 'replay-secret' })).status, 400);
  db.prepare("INSERT INTO password_reset_tokens VALUES('expired','a','expired-token','2000-01-01T00:00:00.000Z',0)").run();
  assert.equal((await post('reset-password', { token: 'expired-token', password: 'new-secret' })).status, 400);
  mode = 'auth-fail'; assert.equal((await post('forgot-password', { email: 'athlete@example.invalid' })).status, 503); mode = 'ok';
  const savedHost = process.env.SMTP_HOST; delete process.env.SMTP_HOST;
  assert.equal((await post('forgot-password', { email: 'athlete@example.invalid' })).status, 503); process.env.SMTP_HOST = savedHost;
  db.prepare("INSERT INTO password_reset_tokens VALUES('deleted','deleted-owner','deleted-token','2999-01-01T00:00:00.000Z',0)").run();
  assert.equal((await post('reset-password', { token: 'deleted-token', password: 'new-secret' })).status, 400);
  process.env.SMTP_HOST = 'smtp.resend.com'; process.env.SMTP_USER = 'resend'; let resendFail = false;
  global.fetch = async (url, options) => { assert.equal(url, 'https://api.resend.com/emails'); const body = JSON.parse(options.body); assert.equal(body.to, 'athlete@example.invalid'); assert.equal(body.subject, 'Reset your Forge password'); return { ok: !resendFail, status: 503, json: async () => ({ message: 'synthetic rejection' }) }; };
  await mail.sendPasswordResetEmail({ to: 'athlete@example.invalid', token: 'synthetic' }); resendFail = true;
  await assert.rejects(mail.sendPasswordResetEmail({ to: 'athlete@example.invalid', token: 'synthetic' }), /Resend email failed/);
  global.fetch = (url, options) => { assert.equal(new URL(url).origin, base); return originalFetch(url, options); };
  const limited = async (ip, route = '/limited', user = 'a') => fetch(base + route, { headers: { 'X-Forwarded-For': ip, 'X-Synthetic-User': user } });
  assert.equal((await limited('2001:db8:1::1')).status, 200); assert.equal((await limited('2001:db8:1::2')).status, 200);
  const blocked = await limited('2001:db8:1::3'); assert.equal(blocked.status, 429); assert.ok(blocked.headers.get('ratelimit-limit'));
  assert.equal((await limited('2001:db8:2::1')).status, 200);
  assert.equal((await limited('192.0.2.1', '/user-limited', 'a')).status, 200); assert.equal((await limited('192.0.2.1', '/user-limited', 'a')).status, 429); assert.equal((await limited('192.0.2.1', '/user-limited', 'b')).status, 200);
  assert.equal(rateLimit.ipKeyGenerator('::ffff:192.0.2.1'), '192.0.2.1'); assert.equal(rateLimit.ipKeyGenerator('192.0.2.1'), '192.0.2.1');
  assert.equal(rateLimit.ipKeyGenerator('not-an-ip'), 'not-an-ip');
  assert.equal(rateLimit.ipKeyGenerator('fe80::1%lo0'), rateLimit.ipKeyGenerator('fe80::2%lo0'));
  assert.equal(rateLimit.ipKeyGenerator('2001:db8:1::1'), rateLimit.ipKeyGenerator('2001:db8:1::99'));
  assert.ok(new Address6('fe81::1').isLinkLocal()); assert.ok(new Address6('64:ff9b:1::1').isPrivate());
  assert.equal(new Address6('a00::1').isInSubnet(new Address4('10.0.0.0/8')), false);
  assert.equal(new Address4('32.1.13.184').isHostInSubnet(new Address6('2001:db8::/32')), false);
  assert.ok(new Address6('2001:db8::1').isInSubnet(new Address6('2001:db8::/32')));
  // Isolate malformed-input/parser work with a hard child deadline, not a main-runner DoS.
  const negative = spawnSync(process.execPath, ['-e', `const a=require('node:assert/strict'); const {Address6}=require('ip-address'); a.equal(Address6.isValid('!'.repeat(100000)),false); const parse=require('nodemailer/lib/addressparser'); a.ok(Array.isArray(parse(' >'+'[x]'.repeat(4000)))); a.ok(Array.isArray(parse('a'+'@b(c)'.repeat(4000)))); console.log('bounded negatives PASS');`], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 3000 });
  assert.equal(negative.status, 0, negative.stderr || String(negative.error));
  db.close();
  console.log('Mail/IP installed compatibility PASS: composition, SMTP Promise/callback/failures, actual auth routes, Resend stub, limiter HTTP and bounded security negatives');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  clearTimeout(deadline); nodemailer.createTransport = originalCreateTransport; global.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv);
  for (const socket of sockets) socket.destroy();
  for (const server of servers) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
});
