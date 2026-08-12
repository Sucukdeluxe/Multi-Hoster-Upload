const test = require('node:test');
const assert = require('node:assert/strict');

const { assertUploadConfirmation } = require('../lib/upload-confirmation');

test('accepts a host-confirmed file code without a public URL', () => {
  const result = { file_code: 'AB1', download_url: null, embed_url: null };
  assert.equal(assertUploadConfirmation(result, 'doodstream.com'), result);
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
    assert.equal(assertUploadConfirmation(result, hoster), result);
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
