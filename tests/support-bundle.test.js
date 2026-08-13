const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sanitizeConfig, collectSecretValues, collectFile, buildSupportBundleText, redactLogText, REDACTED } = require('../lib/support-bundle');

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

test('redactLogText removes complete authorization, cookie, session, HTML credential, and query values', () => {
  const authorization = 'Digest username="private-user", realm="private-realm", response="private-response"';
  const cookie = 'sid=private-cookie; preferences=private-preferences';
  const sessionId = 's3';
  const htmlPassword = 'private-html-password';
  const htmlToken = 'private-html-token';
  const queryToken = 'q1';
  const input = [
    `Authorization: ${authorization}`,
    `Cookie: ${cookie}`,
    `session_id=${sessionId}`,
    `<input type="password" name="password" value="${htmlPassword}">`,
    `<input value="${htmlToken}" name="api_token" type="text">`,
    `https://example.invalid/upload?token=${queryToken}&next=ok`
  ].join('\n');
  const out = redactLogText(input, []);
  for (const value of [authorization, 'private-user', 'private-realm', 'private-response', cookie, 'private-cookie', 'private-preferences', sessionId, htmlPassword, htmlToken, queryToken]) {
    assert.ok(!out.includes(value), `sensitive value survived: ${value}`);
  }
  assert.ok((out.match(/<redacted>/g) || []).length >= 6);
});

test('redactLogText masks a one-character configured secret only as a complete sensitive value', () => {
  const out = redactLogText('status=diagnostics available\npassword=x\nfile=xylophone.mkv\nmarker=x', ['x']);
  assert.ok(out.includes('status=diagnostics available'));
  assert.ok(out.includes('file=xylophone.mkv'));
  assert.ok(!out.includes('password=x'));
  assert.ok(!out.includes('marker=x'));
  assert.ok(out.includes(`password=${REDACTED}`));
  assert.ok(out.includes(`marker=${REDACTED}`));
});

test('redactLogText replaces configured secrets only as complete values', () => {
  const out = redactLogText([
    'password=orange',
    'configured token orange accepted',
    'file=orangejuice',
    'file=orange.mkv',
    'password=.',
    'version=2.1.20',
    'sentence finished.'
  ].join('\n'), ['orange', '.']);
  assert.ok(!out.includes('password=orange'));
  assert.ok(!out.includes('token orange'));
  assert.ok(!out.includes('password=.'));
  assert.ok(out.includes('file=orangejuice'));
  assert.ok(out.includes('file=orange.mkv'));
  assert.ok(out.includes('version=2.1.20'));
  assert.ok(out.includes('sentence finished.'));
});

test('redactLogText removes JSON-escaped configured secrets and quoted HTML credential values', () => {
  const jsonSecret = 'alpha"beta\\gamma';
  const password = 'abc>secret';
  const token = 'token>quoted';
  const input = [
    JSON.stringify({ note: jsonSecret, token: jsonSecret }),
    `<input type="password" value="${password}">`,
    `<input value='${token}' name='api_token' type='text'>`
  ].join('\n');
  const out = redactLogText(input, [jsonSecret]);
  assert.ok(!out.includes(jsonSecret));
  assert.ok(!out.includes('alpha\\"beta\\\\gamma'));
  assert.ok(!out.includes(password));
  assert.ok(!out.includes(token));
  assert.ok((out.match(/<redacted>/g) || []).length >= 3);
});

test('redactLogText removes complete local paths from structured and free-form log text', () => {
  const profilePath = ['C:', 'Users', 'ProfileFixture', 'Private Folder', 'episode.mkv'].join('\\');
  const drivePath = ['D:', 'Archive', 'Private Folder', 'source.mkv'].join('\\');
  const stagedPath = ['E:', 'Staging', 'source.pending-delete'].join('\\');
  const uncPath = ['', '', 'fileserver', 'private-share', 'secret.bin'].join('\\');
  const input = [
    `source ${profilePath}`,
    `failed at ${drivePath}`,
    JSON.stringify({ stagedFile: stagedPath }),
    `network source ${uncPath}`
  ].join('\n');
  const out = redactLogText(input, []);
  for (const value of ['ProfileFixture', 'episode.mkv', 'Private Folder', 'source.mkv', 'source.pending-delete', 'fileserver', 'private-share', 'secret.bin']) {
    assert.ok(!out.includes(value), `private path fragment survived: ${value}`);
  }
  assert.ok((out.match(/<redacted-path>/g) || []).length >= 4);
});

test('redactLogText removes extended UNC, extended drive, UNC and slash-UNC paths', () => {
  const extendedUnc = '\\\\?\\UNC\\private-server\\secret-share\\hidden.log';
  const extendedDrive = '\\\\?\\C:\\Users\\PrivateProfile\\hidden.log';
  const unc = '\\\\private-server\\secret-share\\hidden.log';
  const slashUnc = '//private-server/secret-share/hidden.log';
  const out = redactLogText([
    `extended UNC failure: ${extendedUnc}`,
    `extended drive failure: ${extendedDrive}`,
    `UNC failure: ${unc}`,
    `slash UNC failure: ${slashUnc}`
  ].join('\n'), []);
  for (const fragment of ['private-server', 'secret-share', 'PrivateProfile', 'hidden.log']) {
    assert.ok(!out.includes(fragment), `private path fragment survived: ${fragment}`);
  }
  assert.equal((out.match(/<redacted-path>/g) || []).length, 4);
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
    assert.match(text, /^=== Multi Hoster Uploader Support Bundle ===/);
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
  assert.match(text, /=== Multi Hoster Uploader Support Bundle ===/);
  assert.match(text, /=== Config/);
});

test('buildSupportBundleText never uses an absolute source path as a section label', () => {
  const tmp = path.join(os.tmpdir(), `mhu-bundle-unlabeled-${Date.now()}.log`);
  fs.writeFileSync(tmp, 'safe content\n');
  try {
    const text = buildSupportBundleText({ sanitizedConfig: {}, files: [{ path: tmp }], secrets: [] });
    assert.ok(!text.includes(tmp));
    assert.ok(text.includes('=== log (size='));
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('buildSupportBundleText redacts configured and pattern-detected secrets from included logs', () => {
  const tmp = path.join(os.tmpdir(), `mhu-bundle-secrets-${Date.now()}.log`);
  const configuredSecret = ['configured', 'Secret', '123456'].join('');
  const bearerSecret = ['opaque', 'Bearer', '987654321'].join('');
  const cookieSecret = ['session', 'Cookie', '1122334455'].join('');
  const querySecret = ['query', 'Secret', '6677889900'].join('');
  const privatePath = ['C:', 'Users', 'ProfileFixture', 'Private', 'episode.mkv'].join('\\');
  const stagedPath = ['D:', 'Private', 'episode.pending-delete'].join('\\');
  fs.writeFileSync(tmp, `# SOURCE-CLEANUP ${JSON.stringify({ file: privatePath, stagedFile: stagedPath })}\ntoken=${configuredSecret}\nAuthorization: Bearer ${bearerSecret}\nCookie: sid=${cookieSecret}\nhttps://example.invalid/upload?api_key=${querySecret}\n`);
  try {
    const text = buildSupportBundleText({
      sanitizedConfig: { globalSettings: { logFilePath: privatePath, pendingQueue: { selectedFiles: [{ path: privatePath }] } } },
      secrets: [configuredSecret],
      files: [{ label: 'upload-audit.log', path: tmp }]
    });
    assert.ok(!text.includes(configuredSecret));
    assert.ok(!text.includes(bearerSecret));
    assert.ok(!text.includes(cookieSecret));
    assert.ok(!text.includes(querySecret));
    assert.ok(!text.includes('ProfileFixture'));
    assert.ok(!text.includes('episode.mkv'));
    assert.ok(!text.includes('episode.pending-delete'));
    assert.ok(!text.includes(tmp));
    assert.match(text, /<redacted>/);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('buildSupportBundleText removes configured secrets of every non-empty length', () => {
  const tmp = path.join(os.tmpdir(), `mhu-bundle-short-secrets-${Date.now()}.log`);
  const config = {
    hosters: { 'voe.sx': [{ password: 'p1', apiKey: 'k2' }] },
    globalSettings: { diagnostics: { token: 't3' }, cookie: '', sessionId: null }
  };
  fs.writeFileSync(tmp, 'password=p1\napiKey=k2\ntoken=t3\n');
  try {
    const secrets = collectSecretValues(config);
    assert.deepEqual(new Set(secrets), new Set(['p1', 'k2', 't3']));
    const text = buildSupportBundleText({
      header: { Marker: 'p1-k2-t3' },
      sanitizedConfig: sanitizeConfig(config),
      secrets,
      files: [{ label: 'short-secrets.log', path: tmp }]
    });
    for (const secret of ['p1', 'k2', 't3']) assert.ok(!text.includes(secret), `configured secret survived: ${secret}`);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('buildSupportBundleText removes a one-character configured secret', () => {
  const tmp = path.join(os.tmpdir(), `mhu-bundle-one-character-secret-${Date.now()}.log`);
  const config = { hosters: { 'voe.sx': [{ password: 'x' }] } };
  fs.writeFileSync(tmp, 'password=x\n');
  try {
    const text = buildSupportBundleText({
      header: { Marker: 'secret:x' },
      sanitizedConfig: sanitizeConfig(config),
      secrets: collectSecretValues(config),
      files: [{ label: 'one-character.log', path: tmp }]
    });
    assert.ok(!text.includes('secret:x'));
    assert.ok(!text.includes('password=x'));
    assert.ok(text.includes('one-character.log'));
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('buildSupportBundleText contains no escaped secrets, credential HTML or absolute path variants', () => {
  const tmp = path.join(os.tmpdir(), `mhu-bundle-hard-redaction-${Date.now()}.log`);
  const secret = 'alpha"beta\\gamma';
  const paths = [
    '\\\\?\\UNC\\private-server\\secret-share\\hidden.log',
    '\\\\private-server\\secret-share\\hidden.log',
    '//private-server/secret-share/hidden.log',
    'C:\\Users\\PrivateProfile\\hidden.log'
  ];
  fs.writeFileSync(tmp, [
    JSON.stringify({ token: secret, path: paths[0] }),
    '<input type="password" value="abc>secret">',
    ...paths
  ].join('\n'));
  try {
    const text = buildSupportBundleText({
      header: { Source: paths[3] },
      sanitizedConfig: { marker: JSON.stringify(secret), path: paths[1] },
      secrets: [secret],
      files: [{ label: paths[2], path: tmp }]
    });
    for (const value of ['alpha', 'beta', 'gamma', 'abc>secret', 'private-server', 'secret-share', 'PrivateProfile', 'hidden.log', tmp]) {
      assert.ok(!text.includes(value), `support bundle leak survived: ${value}`);
    }
  } finally {
    fs.unlinkSync(tmp);
  }
});
