// Actual Express proxy resolver; synthetic requests only, no trust-policy changes.
const assert = require('node:assert/strict');
const express = require('express');
const proxyaddr = require('proxy-addr');
assert.equal(require('proxy-addr/package.json').version, '2.0.8');
const request = (remote, forwarded) => ({ socket: { remoteAddress: remote }, headers: { 'x-forwarded-for': forwarded } });
// The mapped subnet must never trust an unrelated native IPv6 peer.
for (const ranges of [['::ffff:127.0.0.1/104'], ['::ffff:127.0.0.1/104', '10.0.0.0/8']]) {
  const trust = proxyaddr.compile(ranges);
  assert.equal(trust('::ffff:127.0.0.2'), true);
  assert.equal(trust('127.0.0.2'), true);
  assert.equal(trust('2001:db8::1'), false);
  assert.equal(trust('::ffff:192.0.2.1'), false);
  assert.equal(proxyaddr(request('2001:db8::1', '127.0.0.1'), trust), '2001:db8::1');
}
// Advisory reproducer: short mapped/zero-prefix IPv6 subnets used to trust
// every IPv4 peer, allowing the peer to select its own forwarded identity.
for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
  for (const ranges of [[subnet], [subnet, '10.0.0.0/8']]) {
    const trust = proxyaddr.compile(ranges);
    for (const peer of ['192.0.2.1', '::ffff:192.0.2.1']) {
      assert.equal(trust(peer), false);
      assert.equal(proxyaddr(request(peer, '127.0.0.1'), trust), peer);
    }
  }
}
const app = express();
for (const [policy, remote, forwarded, expected] of [
  [false, '127.0.0.1', '192.0.2.1', '127.0.0.1'],
  [1, '127.0.0.1', '198.51.100.2, 192.0.2.1', '192.0.2.1'],
  ['loopback', '::ffff:127.0.0.1', '192.0.2.1', '192.0.2.1'],
  ['loopback', '192.0.2.2', '127.0.0.1', '192.0.2.2'],
]) {
  app.set('trust proxy', policy);
  const req = Object.assign(Object.create(app.request), request(remote, forwarded), { app });
  assert.equal(req.ip, expected);
}
console.log('Proxy address compatibility PASS: mapped CIDR spoof rejection, Express direct/hop/loopback trust behavior');
