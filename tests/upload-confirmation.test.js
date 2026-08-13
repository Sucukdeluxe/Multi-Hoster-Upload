const test = require('node:test');
const assert = require('node:assert/strict');

const { assertUploadConfirmation, selectPublicUploadUrl } = require('../lib/upload-confirmation');

test('selects only a real public URL for logs and exports', () => {
  assert.equal(selectPublicUploadUrl({ download_url: 'https://doodstream.com/d/abc123', file_code: 'abc123' }), 'https://doodstream.com/d/abc123');
  assert.equal(selectPublicUploadUrl({ embed_url: 'https://voe.sx/e/abc123', file_code: 'abc123' }), 'https://voe.sx/e/abc123');
  assert.equal(selectPublicUploadUrl({ download_url: 'javascript:alert(1)', file_code: 'abc123' }), '');
  assert.equal(selectPublicUploadUrl({ file_code: 'abc123' }), '');
});

test('materializes canonical Doodstream URLs from a confirmed file code', () => {
  assert.deepEqual(
    assertUploadConfirmation({ file_code: 'AB1', download_url: null, embed_url: null }, 'doodstream.com'),
    {
      file_code: 'AB1',
      download_url: 'https://doodstream.com/d/AB1',
      embed_url: 'https://doodstream.com/e/AB1'
    }
  );
});

test('accepts upload URLs for every supported hoster and its subdomains', () => {
  const cases = [
    ['doodstream.com', 'https://doodstream.com/d/abc123'],
    ['voe.sx', 'https://cdn.voe.sx/abc123'],
    ['vidmoly.me', 'https://vidmoly.me/w/abc123'],
    ['byse.sx', 'https://media.byse.sx/d/abc123'],
    ['clouddrop.cc', 'https://clouddrop.cc/share/abc123']
  ];
  for (const [hoster, downloadUrl] of cases) {
    const result = { file_code: 'abc123', download_url: downloadUrl };
    const confirmed = assertUploadConfirmation(result, hoster);
    if (hoster === 'doodstream.com') {
      assert.deepEqual(confirmed, {
        ...result,
        embed_url: 'https://doodstream.com/e/abc123'
      });
    } else {
      assert.equal(confirmed, result);
    }
  }
});

test('accepts Doodstream result links on its current public domains', () => {
  const result = {
    file_code: 'DOODCODE1234',
    download_url: 'https://dood.to/d/DOODCODE1234',
    embed_url: 'https://dood.la/e/DOODCODE1234'
  };
  assert.deepEqual(assertUploadConfirmation(result, 'doodstream.com'), {
    ...result,
    download_url: 'https://doodstream.com/d/DOODCODE1234',
    embed_url: 'https://doodstream.com/e/DOODCODE1234'
  });
});

test('accepts the Doodstream result domain returned by the current upload service', () => {
  const result = {
    file_code: 'DOODCODE1234',
    download_url: 'https://dsvplay.com/d/DOODCODE1234',
    embed_url: 'https://dsvplay.com/e/DOODCODE1234'
  };
  assert.deepEqual(assertUploadConfirmation(result, 'doodstream.com'), {
    ...result,
    download_url: 'https://doodstream.com/d/DOODCODE1234',
    embed_url: 'https://doodstream.com/e/DOODCODE1234'
  });
});

test('rebuilds every accepted Doodstream transport URL from the file code', () => {
  const variants = [
    'http://dsvplay.com/d/DOODCODE1234?token=SYNTHETIC_SECRET#fragment',
    'https://edge.dsvplay.com/result/DOODCODE1234?session=SYNTHETIC_SESSION',
    'https://dood.to/e/DOODCODE1234',
    'https://dood.la/arbitrary/DOODCODE1234'
  ];

  for (const downloadUrl of variants) {
    assert.deepEqual(
      assertUploadConfirmation({ file_code: 'DOODCODE1234', download_url: downloadUrl }, 'doodstream.com'),
      {
        file_code: 'DOODCODE1234',
        download_url: 'https://doodstream.com/d/DOODCODE1234',
        embed_url: 'https://doodstream.com/e/DOODCODE1234'
      }
    );
  }
});

test('rejects code-only confirmations for hosters without canonical materialization', () => {
  assert.throws(
    () => assertUploadConfirmation({ file_code: 'BYSE123' }, 'byse.sx'),
    /Upload zu byse\.sx wurde nicht bestätigt/
  );
});

test('rejects non-HTTPS public URLs outside Doodstream transport normalization', () => {
  assert.throws(
    () => assertUploadConfirmation({ file_code: 'VOE123', download_url: 'http://voe.sx/VOE123' }, 'voe.sx'),
    /Upload zu voe\.sx wurde nicht bestätigt/
  );
});

test('rejects an upload URL from a different domain', () => {
  assert.throws(
    () => assertUploadConfirmation({ file_code: 'abc123', download_url: 'https://attacker.invalid/file/abc123' }, 'voe.sx'),
    /Upload zu voe\.sx wurde nicht bestätigt/
  );
});

test('rejects a syntactically invalid file code despite a valid hoster URL', () => {
  assert.throws(
    () => assertUploadConfirmation({ file_code: 'not a code', download_url: 'https://vidmoly.me/w/not-a-code' }, 'vidmoly.me'),
    /Upload zu vidmoly\.me wurde nicht bestätigt/
  );
});

test('rejects a valid hoster URL without a file code', () => {
  assert.throws(
    () => assertUploadConfirmation({ download_url: 'https://byse.sx/d/abc123' }, 'byse.sx'),
    (err) => {
      assert.match(err.message, /Upload zu byse\.sx wurde nicht bestätigt/);
      assert.equal(err.diagnostic.payloadSnippet, '{"fileCodeLength":0,"urlHosts":["byse.sx"]}');
      return true;
    }
  );
});

test('rejects an empty upload response', () => {
  assert.throws(
    () => assertUploadConfirmation({}, 'byse.sx'),
    /Upload zu byse\.sx wurde nicht bestätigt/
  );
});

test('rejects non-network links despite a valid file code', () => {
  assert.throws(
    () => assertUploadConfirmation({ file_code: 'abc123', download_url: 'javascript:alert(1)' }, 'vidmoly.me'),
    /Upload zu vidmoly\.me wurde nicht bestätigt/
  );
});
