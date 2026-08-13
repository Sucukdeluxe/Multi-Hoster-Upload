const test = require('node:test');
const assert = require('node:assert/strict');

const VoeUploader = require('../lib/voe-upload');
const VidmolyUploader = require('../lib/vidmoly-upload');
const { createRecoveryClaimRegistry } = require('../lib/hosters');

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

test('VOE concurrent same-name recovery claims one remote entry only once', async () => {
  const registry = createRecoveryClaimRegistry();
  const first = new VoeUploader(registry.forUpload('voe.sx', 'ACCOUNT', 'Shared Episode.mkv'));
  const second = new VoeUploader(registry.forUpload('voe.sx', 'ACCOUNT', 'shared-episode.mp4'));
  const remoteFiles = [{ file_code: 'VOE_SHARED', title: 'shared episode' }];
  first._fetchFileList = async () => remoteFiles;
  second._fetchFileList = async () => remoteFiles;
  first._sleep = async () => {};
  second._sleep = async () => {};

  const results = await Promise.all([
    first._resolveUploadedFile('C:\\source-a\\Shared Episode.mkv', new Set(), null),
    second._resolveUploadedFile('D:\\source-b\\shared-episode.mp4', new Set(), null)
  ]);

  assert.deepEqual(results.filter(Boolean).map(result => result.file_code), ['VOE_SHARED']);
});

test('VOE concurrent same-name recovery accepts distinct remote codes', async () => {
  const registry = createRecoveryClaimRegistry();
  const first = new VoeUploader(registry.forUpload('voe.sx', 'ACCOUNT', 'Shared Episode.mkv'));
  const second = new VoeUploader(registry.forUpload('voe.sx', 'ACCOUNT', 'shared-episode.mp4'));
  first._fetchFileList = async () => [{ file_code: 'VOE_FIRST', title: 'shared episode' }];
  second._fetchFileList = async () => [{ file_code: 'VOE_SECOND', title: 'shared episode' }];
  first._sleep = async () => {};
  second._sleep = async () => {};

  const results = await Promise.all([
    first._resolveUploadedFile('C:\\source-a\\Shared Episode.mkv', new Set(), null),
    second._resolveUploadedFile('D:\\source-b\\shared-episode.mp4', new Set(), null)
  ]);

  assert.deepEqual(results.map(result => result.file_code), ['VOE_FIRST', 'VOE_SECOND']);
});

test('Vidmoly concurrent same-name recovery claims one remote entry only once', async () => {
  const registry = createRecoveryClaimRegistry();
  const first = new VidmolyUploader(registry.forUpload('vidmoly.me', 'ACCOUNT', 'Shared Episode.mkv'));
  const second = new VidmolyUploader(registry.forUpload('vidmoly.me', 'ACCOUNT', 'shared-episode.mp4'));
  const remoteFiles = [{ file_code: 'VIDSHARED001', full_title: 'shared episode' }];
  first._fetchVmList = async () => remoteFiles;
  second._fetchVmList = async () => remoteFiles;
  first._sleep = async () => {};
  second._sleep = async () => {};

  const results = await Promise.all([
    first._resolveUploadedFileFromVmApi('C:\\source-a\\Shared Episode.mkv', new Set(), null),
    second._resolveUploadedFileFromVmApi('D:\\source-b\\shared-episode.mp4', new Set(), null)
  ]);

  assert.deepEqual(results.filter(Boolean).map(result => result.file_code), ['VIDSHARED001']);
});

test('Vidmoly concurrent same-name recovery accepts distinct remote codes', async () => {
  const registry = createRecoveryClaimRegistry();
  const first = new VidmolyUploader(registry.forUpload('vidmoly.me', 'ACCOUNT', 'Shared Episode.mkv'));
  const second = new VidmolyUploader(registry.forUpload('vidmoly.me', 'ACCOUNT', 'shared-episode.mp4'));
  first._fetchVmList = async () => [{ file_code: 'VIDFIRST0001', full_title: 'shared episode' }];
  second._fetchVmList = async () => [{ file_code: 'VIDSECOND001', full_title: 'shared episode' }];
  first._sleep = async () => {};
  second._sleep = async () => {};

  const results = await Promise.all([
    first._resolveUploadedFileFromVmApi('C:\\source-a\\Shared Episode.mkv', new Set(), null),
    second._resolveUploadedFileFromVmApi('D:\\source-b\\shared-episode.mp4', new Set(), null)
  ]);

  assert.deepEqual(results.map(result => result.file_code), ['VIDFIRST0001', 'VIDSECOND001']);
});

for (const scenario of [
  {
    label: 'VOE',
    hoster: 'voe.sx',
    Uploader: VoeUploader,
    sharedCode: 'VOE_UNCERTAIN',
    lateCode: 'VOE_LATE_CODE',
    build(uploader, code) {
      return uploader._buildUrls(code);
    }
  },
  {
    label: 'Vidmoly',
    hoster: 'vidmoly.me',
    Uploader: VidmolyUploader,
    sharedCode: 'VIDUNCERTAIN',
    lateCode: 'VIDLATECODE1',
    build(uploader, code) {
      return uploader._buildUrlsFromCode(code);
    }
  }
]) {
  test(`${scenario.label} marks a duplicate direct identity uncertain and blocks a later title match`, async () => {
    const registry = createRecoveryClaimRegistry();
    const firstClaim = registry.forUpload(scenario.hoster, 'ACCOUNT', 'First Episode.mkv');
    const uncertainClaim = registry.forUpload(scenario.hoster, 'ACCOUNT', 'Second Episode.mkv');
    const first = new scenario.Uploader(firstClaim);
    const uncertain = new scenario.Uploader(uncertainClaim);

    scenario.build(first, scenario.sharedCode);
    assert.throws(
      () => scenario.build(uncertain, scenario.sharedCode),
      err => err.remoteIdentityClaimed === true && err.remoteCommitUncertain === true
    );

    const laterClaim = registry.forUpload(scenario.hoster, 'ACCOUNT', 'Second Episode.mp4');
    await assert.rejects(
      () => laterClaim.runExclusive(async () => scenario.build(new scenario.Uploader(laterClaim), scenario.lateCode)),
      err => err.remoteCommitUncertain === true
    );
  });
}
