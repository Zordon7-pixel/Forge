'use strict';

const dns = require('node:dns');
const https = require('node:https');
const tls = require('node:tls');
const { isIP, BlockList } = require('node:net');
const { performance } = require('node:perf_hooks');
const webpush = require('web-push');

const DEADLINE_MS = 8000;
const RESPONSE_BYTES = 8192;
const httpFailures = new WeakSet();
function failure(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  if (statusCode !== undefined) { error.statusCode = statusCode; httpFailures.add(error); }
  return error;
}
function expiredEndpoint(error) {
  return httpFailures.has(error) && (error.statusCode === 404 || error.statusCode === 410);
}
function configurationFailure(error) {
  return httpFailures.has(error) && (error.statusCode === 401 || error.statusCode === 403);
}

// Do not normalize the opaque path/query or persisted endpoint identity with URL().
function validateEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length < 1 || endpoint.length > 2048
    || /[^\x21-\x7e]|[\\#]/.test(endpoint) || /%(?![0-9a-fA-F]{2})/.test(endpoint)) {
    throw failure('WEB_PUSH_ENDPOINT_INVALID');
  }
  const match = /^https:\/\/([^/?]+)(.*)$/.exec(endpoint);
  if (!match) throw failure('WEB_PUSH_ENDPOINT_INVALID');
  const host = match[1].toLowerCase();
  const labels = host.split('.');
  if (host.length > 253 || labels.some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    || label.startsWith('xn--')) || isIP(host)
    || !(host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com'
      || (host.endsWith('.push.apple.com') && labels.length > 3))) {
    throw failure('WEB_PUSH_ENDPOINT_INVALID');
  }
  return Object.freeze({ endpoint, host, path: match[2].startsWith('/') ? match[2] : `/${match[2]}` });
}

const excluded = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],
]) excluded.addSubnet(address, prefix, 'ipv4');
// Only global unicast space is eligible; special-purpose allocations fail closed.
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) {
  excluded.addSubnet(address, prefix, 'ipv6');
}
function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !excluded.check(address, 'ipv4');
  return family === 6 && !address.includes('%') && globalV6.check(address, 'ipv6') && !excluded.check(address, 'ipv6');
}

// Dependency injection is an internal synthetic-test seam, never request options.
function createWebPushTransport({ resolverFactory = () => new dns.Resolver(), request = https.request,
  now = () => performance.now(), schedule = setTimeout, unschedule = clearTimeout } = {}) {
  return function send(subscription, payload, { vapidDetails, signal, beforeSend } = {}) {
    const started = now();
    return new Promise((resolve, reject) => {
      let settled = false, timer, resolver, req, response, agent;
      const cleanup = () => {
        if (timer !== undefined) unschedule(timer);
        signal?.removeEventListener('abort', onAbort);
        resolver?.cancel();
        response?.destroy();
        req?.destroy();
        agent?.destroy();
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve(result);
      };
      const onAbort = () => finish(failure('WEB_PUSH_ABORTED'));
      const deadline = () => {
        const remaining = DEADLINE_MS - (now() - started);
        if (remaining <= 0) finish(failure('WEB_PUSH_TIMEOUT'));
        else timer = schedule(deadline, remaining);
      };
      const alive = () => {
        if (!settled && now() - started >= DEADLINE_MS) finish(failure('WEB_PUSH_TIMEOUT'));
        return !settled;
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      deadline();
      (async () => {
        try {
          const target = validateEndpoint(subscription?.endpoint);
          if (typeof payload !== 'string' || Buffer.byteLength(payload) > 4096) throw failure('WEB_PUSH_PAYLOAD_INVALID');
          // The installed library owns encryption and VAPID generation. Never use its sender.
          let details;
          try {
            if (!vapidDetails?.publicKey || !vapidDetails?.privateKey || !vapidDetails?.subject) throw new Error('missing configuration');
            details = webpush.generateRequestDetails(subscription, payload, { vapidDetails, TTL: 300 });
          }
          catch { throw failure('WEB_PUSH_REQUEST_INVALID'); }
          if (!alive()) return;
          resolver = resolverFactory();
          const lookup = family => new Promise((yes, no) => {
            resolver[`resolve${family}`](target.host, (error, addresses) => {
              if (error && error.code !== 'ENODATA') { no(failure('WEB_PUSH_DNS_FAILED')); return; }
              yes(error ? [] : addresses);
            });
          });
          const records = await Promise.all([lookup(4), lookup(6)]);
          if (!alive()) return;
          const addresses = records.flat();
          if (!addresses.length || addresses.length > 64 || addresses.some(address => !publicAddress(address))) {
            throw failure('WEB_PUSH_DNS_UNSAFE');
          }
          const address = addresses[0], family = isIP(address);
          if (beforeSend && await beforeSend() !== true) throw failure('WEB_PUSH_TARGET_STALE');
          if (!alive()) return;
          const pinnedLookup = (hostname, options, callback) => {
            if (typeof options === 'function') { callback = options; options = {}; }
            if (hostname !== target.host) { callback(failure('WEB_PUSH_DNS_UNSAFE')); return; }
            callback(null, options?.all ? [{ address, family }] : address, family);
          };
          agent = new https.Agent({ keepAlive: false, maxSockets: 1, proxyEnv: {} });
          req = request({ protocol: 'https:', hostname: target.host, port: 443, path: target.path,
            method: 'POST', headers: details.headers, agent, lookup: pinnedLookup,
            servername: target.host, rejectUnauthorized: true, checkServerIdentity: tls.checkServerIdentity,
          }, incoming => {
            response = incoming;
            response.on('error', () => finish(failure('WEB_PUSH_NETWORK_FAILED')));
            response.on('aborted', () => finish(failure('WEB_PUSH_NETWORK_FAILED')));
            if (!alive()) { response.destroy(); return; }
            let bytes = 0;
            response.on('data', chunk => {
              bytes += Buffer.byteLength(chunk);
              if (bytes > RESPONSE_BYTES) finish(failure('WEB_PUSH_RESPONSE_TOO_LARGE'));
              else alive();
            });
            response.on('end', () => {
              if (!alive()) return;
              const status = response.statusCode;
              if (!Number.isInteger(status) || status < 100 || status > 599) finish(failure('WEB_PUSH_RESPONSE_INVALID'));
              else if (status >= 200 && status < 300) finish(null, Object.freeze({ statusCode: status }));
              else finish(failure(`WEB_PUSH_HTTP_${status}`, status));
            });
          });
          req.on('error', () => finish(failure('WEB_PUSH_NETWORK_FAILED')));
          if (!alive()) { req.destroy(); return; }
          req.end(details.body);
        } catch (error) {
          const allowed = ['WEB_PUSH_ENDPOINT_INVALID','WEB_PUSH_PAYLOAD_INVALID','WEB_PUSH_REQUEST_INVALID',
            'WEB_PUSH_DNS_FAILED','WEB_PUSH_DNS_UNSAFE','WEB_PUSH_TARGET_STALE'];
          finish(failure(allowed.includes(error?.code) ? error.code : 'WEB_PUSH_NETWORK_FAILED'));
        }
      })();
    });
  };
}

module.exports = { createWebPushTransport, send: createWebPushTransport(), validateEndpoint, publicAddress, expiredEndpoint, configurationFailure,
  DEADLINE_MS, RESPONSE_BYTES };
