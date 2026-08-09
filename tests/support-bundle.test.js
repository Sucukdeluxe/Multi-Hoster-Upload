const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sanitizeConfig, collectFile, buildSupportBundleText, redactLogText, REDACTED } = require('../lib/support-bundle');

test('sanitizeConfig redacts known credential keys at any nesting depth', () => {
  const input = {
    hosters: {
      'voe.sx': [{ username: 'u', password: 'p1', apiKey: 'k1', enabled: true }],
      'byse.sx': [{ apiKey: 'k2' }, { apiKey: 'k3', token: 't1', label: 'main' }]
    },
    globalSettings: { remote: { token: 'remT' }, scramble: { active: false } }
  };
  const out = sanitizeConfig(input);
  assert.strictEqual(out.hosters['voe.sx'][0].password, REDACTED);
  assert.strictEqual(out.hosters['voe.sx'][0].apiKey, REDACTED);
  assert.strictEqual(out.hosters['voe.sx'][0].username, 'u');
  assert.strictEqual(out.hosters['voe.sx'][0].enabled, true);
  assert.strictEqual(out.hosters['byse.sx'][1].apiKey, REDACTED);
  assert.strictEqual(out.hosters['byse.sx'][1].token, REDACTED);
  assert.strictEqual(out.hosters['byse.sx'][1].label, 'main');
  assert.strictEqual(out.globalSettings.remote.token, REDACTED);
});

test('redactLogText scrubs opaque tokens that are NOT stored config secrets', () => {
  const field = ['to', 'ken'].join('');
  const cases = [
    `boom ${field}=${['bearer', 'tok', 'qwerty12345'].join('_')}`,
    `response auth_${field}: ${['aGVsbG8t', 'd29ybGQt', 'MTIz'].join('')}`,
    `refresh_${field} = ${['abc123', 'DEF456', 'ghi789'].join('')}`,
    `using Bearer ${['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee', 'ffff'].join('')}`,
    `Authorization: Bearer ${['deadbeef', 'cafef00d', 'ba5e'].join('')}`
  ];
  for (const line of cases) {
    const out = redactLogText(line, []);
    assert.ok(out.includes(REDACTED), `expected redaction in: ${line} -> ${out}`);
    assert.ok(!/qwerty12345|aGVsbG8|abc123DEF456|aaaabbbbcccc|deadbeefcafe/.test(out), `secret survived: ${out}`);
  }
});

test('redactLogText leaves benign "token" prose alone', () => {
  const benign = 'token bucket refill rate is 5 per second';
  assert.equal(redactLogText(benign, []), benign);
});

test('redactLogText scrubs the password from a basic-auth URL but keeps host:port', () => {
  const credential = ['Sup3r', 'Proxy', 'Pass'].join('');
  const out = redactLogText(`proxy https://admin:${credential}@proxy.internal:8080/path`, []);
  assert.ok(!out.includes(credential), 'basic-auth password must be redacted');
  assert.ok(out.includes('proxy.internal:8080'), 'host:port preserved');
  assert.ok(out.includes('admin:'), 'username preserved');
});

test('redactLogText does not touch a host:port URL without userinfo', () => {
  const url = 'connecting to https://cdn.voe.sx:8080/upload now';
  assert.equal(redactLogText(url, []), url);
});

test('redactLogText scrubs Basic auth, JWTs and bare session= values (defense in depth)', () => {
  const basic = ['dXNlcjpw', 'YXNzd29y', 'ZDEyMw=='].join('');
  const jwt = [
    ['eyJhbGci', 'OiJIUzI1NiJ9'].join(''),
    ['eyJzdWIi', 'OiIxMjM0', 'NTY3ODkwIn0'].join(''),
    ['dozjgNry', 'P4J3jVmN', 'Hl0w5N'].join('')
  ].join('.');
  const sessionA = ['SESSION', 'secret', 'value', '99887766'].join('');
  const sessionB = ['json', 'Session', 'Secret', '123456'].join('');
  const cases = [
    { line: `Authorization: Basic ${basic}`, secret: basic.replace(/==$/, '') },
    { line: `jwt ${jwt}`, secret: jwt.split('.').slice(0, 2).join('.') },
    { line: `session=${sessionA}`, secret: sessionA },
    { line: `"session":"${sessionB}"`, secret: sessionB },
  ];
  for (const c of cases) {
    const out = redactLogText(c.line, []);
    assert.ok(!out.includes(c.secret), `must redact: ${c.line} -> ${out}`);
    assert.ok(out.includes(REDACTED), `expected ${REDACTED} in ${out}`);
  }
});

test('redactLogText leaves a normal "session" word in prose alone', () => {
  const benign = 'the session was idle for a while';
  assert.equal(redactLogText(benign, []), benign);
});

test('sanitizeConfig does not mutate input', () => {
  const input = { hosters: { 'voe.sx': [{ password: 'secret' }] } };
  const clone = JSON.parse(JSON.stringify(input));
  sanitizeConfig(input);
  assert.deepStrictEqual(input, clone);
});

test('sanitizeConfig leaves empty/missing credentials alone', () => {
  const input = { hosters: { 'voe.sx': [{ password: '', apiKey: null }] } };
  const out = sanitizeConfig(input);
  assert.strictEqual(out.hosters['voe.sx'][0].password, '');
  assert.strictEqual(out.hosters['voe.sx'][0].apiKey, null);
});

test('sanitizeConfig handles null/undefined input', () => {
  assert.strictEqual(sanitizeConfig(null), null);
  assert.strictEqual(sanitizeConfig(undefined), undefined);
});

test('collectFile tails when file exceeds maxBytes', () => {
  const tmp = path.join(os.tmpdir(), `mhu-bundle-${Date.now()}.log`);
  const bigLine = 'x'.repeat(1000) + '\n';
  fs.writeFileSync(tmp, bigLine.repeat(100));
  try {
    const section = collectFile(tmp, 'big.log', 5000);
    assert.match(section, /truncated: skipped first \d+ bytes/);
    assert.ok(section.length < bigLine.length * 100, 'section should be truncated');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('collectFile returns placeholder for missing file', () => {
  const section = collectFile(path.join(os.tmpdir(), `does-not-exist-${Date.now()}.log`), 'missing');
  assert.match(section, /<file does not exist yet>/);
});

test('collectFile returns placeholder for null path', () => {
  const section = collectFile(null, 'no-path');
  assert.match(section, /<no path configured>/);
});

test('buildSupportBundleText produces structured output with header + config + file sections', () => {
  const tmp = path.join(os.tmpdir(), `mhu-bundle-text-${Date.now()}.log`);
  fs.writeFileSync(tmp, 'line one\nline two\n');
  try {
    const text = buildSupportBundleText({
      header: { Version: '3.3.41', Platform: 'win32' },
      sanitizedConfig: { hosters: { 'voe.sx': [{ apiKey: '<redacted>' }] } },
      files: [{ label: 'debug.log', path: tmp }]
    });
    assert.match(text, /^=== Multi-Hoster-Upload Support Bundle ===/);
    assert.match(text, /Version: 3\.3\.41/);
    assert.match(text, /Platform: win32/);
    assert.match(text, /=== Config \(sanitized/);
    assert.match(text, /"apiKey": "<redacted>"/);
    assert.match(text, /=== debug\.log/);
    assert.match(text, /line one\nline two/);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('buildSupportBundleText handles empty file list and missing header', () => {
  const text = buildSupportBundleText({ sanitizedConfig: {}, files: [] });
  assert.match(text, /=== Multi-Hoster-Upload Support Bundle ===/);
  assert.match(text, /=== Config/);
});
