const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sanitizeConfig, collectFile, buildSupportBundleText, redactLogText, REDACTED } = require('../lib/support-bundle');

const artificialSecret = (...fragments) => fragments.join('');

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
  const secrets = [
    artificialSecret('fixture_token_', 'qwerty', '12345'),
    artificialSecret('fixture_auth_', 'value', '123456'),
    artificialSecret('fixture_refresh_', 'value', '123456'),
    artificialSecret('fixture_bearer_', 'value', '123456'),
    artificialSecret('fixture_authorization_', 'value', '123456')
  ];
  const cases = [
    `boom token=${secrets[0]}`,
    `response auth_token: ${secrets[1]}`,
    `refresh_token = ${secrets[2]}`,
    `using Bearer ${secrets[3]}`,
    `Authorization: Bearer ${secrets[4]}`
  ];
  for (const [index, line] of cases.entries()) {
    const out = redactLogText(line, []);
    assert.ok(out.includes(REDACTED), `expected redaction in: ${line} -> ${out}`);
    assert.ok(!out.includes(secrets[index]), `secret survived: ${out}`);
  }
});

test('redactLogText leaves benign "token" prose alone', () => {
  const benign = 'token bucket refill rate is 5 per second';
  assert.equal(redactLogText(benign, []), benign);
});

test('redactLogText scrubs the password from a basic-auth URL but keeps host:port', () => {
  const password = artificialSecret('fixture', 'Proxy', 'Password');
  const out = redactLogText(`proxy https://admin:${password}@proxy.internal:8080/path`, []);
  assert.ok(!out.includes(password), 'basic-auth password must be redacted');
  assert.ok(out.includes('proxy.internal:8080'), 'host:port preserved');
  assert.ok(out.includes('admin:'), 'username preserved');
});

test('redactLogText does not touch a host:port URL without userinfo', () => {
  const url = 'connecting to https://cdn.voe.sx:8080/upload now';
  assert.equal(redactLogText(url, []), url);
});

test('redactLogText scrubs Basic auth, JWTs and bare session= values (defense in depth)', () => {
  const basicValue = artificialSecret('dXNlcjpw', 'YXNzd29y', 'ZDEyMw');
  const jwtValue = artificialSecret('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N');
  const jwtSecret = artificialSecret('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0');
  const sessionValue = artificialSecret('fixture', 'Session', 'Value', '99887766');
  const jsonSessionValue = artificialSecret('fixture', 'Json', 'Session', '123456');
  const cases = [
    { line: `Authorization: Basic ${basicValue}==`, secret: basicValue },
    { line: `jwt ${jwtValue}`, secret: jwtSecret },
    { line: `session=${sessionValue}`, secret: sessionValue },
    { line: `"session":"${jsonSessionValue}"`, secret: jsonSessionValue },
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
