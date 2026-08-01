const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeIp, isLoopbackIp, matchIpRule, evaluateClientAllowed } = require('../lib/ip-allowlist');

test('normalizeIp strips ::ffff: and lowercases', () => {
  assert.equal(normalizeIp('::ffff:100.64.0.5'), '100.64.0.5');
  assert.equal(normalizeIp('::FFFF:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp('  100.64.0.5 '), '100.64.0.5');
});

test('loopback is always allowed, even with a non-matching allowlist', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '', 'localhost', '127.5.5.5']) {
    assert.equal(evaluateClientAllowed(ip, ['203.0.113.5']), true, `${ip} loopback`);
  }
});

test('fail-closed: empty allowlist rejects every non-loopback peer', () => {
  for (const ip of ['100.64.0.5', '203.0.113.5', '10.0.0.2', '::ffff:192.168.1.9']) {
    assert.equal(evaluateClientAllowed(ip, []), false, `${ip} must be rejected with empty allowlist`);
  }
});

test('exact IP allow + reject', () => {
  assert.equal(evaluateClientAllowed('203.0.113.5', ['203.0.113.5']), true);
  assert.equal(evaluateClientAllowed('203.0.113.6', ['203.0.113.5']), false);
});

test('CIDR matching incl. the Tailscale CGNAT range 100.64.0.0/10', () => {
  assert.equal(evaluateClientAllowed('100.64.0.5', ['100.64.0.0/10']), true);
  assert.equal(evaluateClientAllowed('100.127.255.254', ['100.64.0.0/10']), true);
  assert.equal(evaluateClientAllowed('100.128.0.1', ['100.64.0.0/10']), false, 'just outside the /10');
  assert.equal(evaluateClientAllowed('::ffff:100.64.0.5', ['100.64.0.0/10']), true, 'mapped v4 in CIDR');
  assert.equal(evaluateClientAllowed('10.0.0.5', ['10.0.0.0/24']), true);
  assert.equal(evaluateClientAllowed('10.0.1.5', ['10.0.0.0/24']), false);
});

test('wildcard rules allow everything', () => {
  assert.equal(evaluateClientAllowed('8.8.8.8', ['*']), true);
  assert.equal(evaluateClientAllowed('8.8.8.8', ['0.0.0.0/0']), true);
});

test('matchIpRule rejects malformed rules and out-of-range octets', () => {
  assert.equal(matchIpRule('1.2.3.4', 'not-an-ip'), false);
  assert.equal(matchIpRule('1.2.3.4', '1.2.3.0/33'), false);
  assert.equal(matchIpRule('1.2.3.999', '1.2.3.0/24'), false);
});

test('isLoopbackIp recognizes loopback forms', () => {
  assert.equal(isLoopbackIp('127.0.0.1'), true);
  assert.equal(isLoopbackIp('::1'), true);
  assert.equal(isLoopbackIp('100.64.0.1'), false);
});
