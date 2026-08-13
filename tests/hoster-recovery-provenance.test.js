const test = require('node:test');
const assert = require('node:assert/strict');

const VoeUploader = require('../lib/voe-upload');
const VidmolyUploader = require('../lib/vidmoly-upload');

function response(body, status = 200, contentType = 'application/json') {
  return {
    status,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
    text: async () => body
  };
}

test('VOE recovery rejects an unrelated singleton candidate', async () => {
  const uploader = new VoeUploader();
  uploader._fetchFileList = async () => [{ file_code: 'OTHER999', title: 'foreign-upload' }];
  uploader._sleep = async () => {};

  assert.equal(await uploader._resolveUploadedFile('wanted-video.mkv', new Set(), null), null);
});

test('VOE recovery rejects ambiguous exact-title candidates', async () => {
  const uploader = new VoeUploader();
  uploader._fetchFileList = async () => [
    { file_code: 'VOE_FIRST', title: 'wanted-video' },
    { file_code: 'VOE_SECOND', title: 'wanted-video' }
  ];
  uploader._sleep = async () => {};

  assert.equal(await uploader._resolveUploadedFile('wanted-video.mkv', new Set(), null), null);
});

test('VOE recovery accepts one new exact-title candidate with a file extension', async () => {
  const uploader = new VoeUploader();
  uploader._fetchFileList = async () => [{ file_code: 'VOE_EXACT', title: 'wanted-video.mkv' }];
  uploader._sleep = async () => {};

  assert.deepEqual(await uploader._resolveUploadedFile('wanted-video.mkv', new Set(), null), {
    file_code: 'VOE_EXACT',
    download_url: 'https://voe.sx/VOE_EXACT',
    embed_url: 'https://voe.sx/e/VOE_EXACT'
  });
});

test('VOE preserves a failed recovery baseline as a safe structured error', async () => {
  const uploader = new VoeUploader();
  uploader._fetch = async () => response(
    '<html>api_key=SYNTHETIC_VOE_SECRET https://voe.sx/list?session=SYNTHETIC_VOE_SESSION</html>',
    503,
    'text/html'
  );

  await assert.rejects(
    () => uploader._captureFileCodes(),
    (err) => {
      assert.doesNotMatch(err.message, /SYNTHETIC_VOE_SECRET|SYNTHETIC_VOE_SESSION|<html>/);
      assert.equal(err.diagnostic.phase, 'recovery-baseline');
      assert.equal(err.diagnostic.http, 503);
      assert.equal(err.diagnostic.responseKind, 'html');
      return true;
    }
  );
});

test('Vidmoly recovery rejects a matching code already present in the baseline', async () => {
  const uploader = new VidmolyUploader();
  uploader._fetchVmList = async () => [{ file_code: ' OLDVID123456 ', full_title: 'wanted-video' }];
  uploader._sleep = async () => {};

  assert.equal(
    await uploader._resolveUploadedFileFromVmApi('wanted-video.mkv', new Set(['OLDVID123456']), null),
    null
  );
});

test('Vidmoly recovery rejects ambiguous exact-title candidates', async () => {
  const uploader = new VidmolyUploader();
  uploader._fetchVmList = async () => [
    { file_code: 'NEWVID123456', full_title: 'wanted-video' },
    { file_code: 'NEWVID654321', full_title: 'wanted-video' }
  ];
  uploader._sleep = async () => {};

  assert.equal(await uploader._resolveUploadedFileFromVmApi('wanted-video.mkv', new Set(), null), null);
});

test('Vidmoly recovery accepts one new exact-title candidate with a file extension', async () => {
  const uploader = new VidmolyUploader();
  uploader._fetchVmList = async () => [{ file_code: 'NEWVID123456', full_title: 'wanted-video.mkv' }];
  uploader._sleep = async () => {};

  assert.deepEqual(await uploader._resolveUploadedFileFromVmApi('wanted-video.mkv', new Set(), null), {
    file_code: 'NEWVID123456',
    download_url: 'https://vidmoly.me/w/NEWVID123456',
    embed_url: 'https://vidmoly.me/embed-NEWVID123456.html'
  });
});

test('Vidmoly preserves a failed recovery baseline as a safe structured error', async () => {
  const uploader = new VidmolyUploader();
  uploader._fetch = async () => response(
    '<html>sess_id=SYNTHETIC_VIDMOLY_SECRET https://vidmoly.me/?token=SYNTHETIC_VIDMOLY_SESSION</html>',
    503,
    'text/html'
  );

  await assert.rejects(
    () => uploader._captureVmFileCodes(),
    (err) => {
      assert.doesNotMatch(err.message, /SYNTHETIC_VIDMOLY_SECRET|SYNTHETIC_VIDMOLY_SESSION|<html>/);
      assert.equal(err.diagnostic.phase, 'recovery-baseline');
      assert.equal(err.diagnostic.http, 503);
      assert.equal(err.diagnostic.responseKind, 'html');
      return true;
    }
  );
});
