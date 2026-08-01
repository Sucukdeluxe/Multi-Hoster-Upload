const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectKind, isVideoLikeKind, probeFileHead, summarizeFileStat } = require('../lib/file-probe');

function tmpWrite(name, buf) {
  const p = path.join(os.tmpdir(), `mhu-probe-${Date.now()}-${name}`);
  fs.writeFileSync(p, buf);
  return p;
}

test('detectKind recognizes ISO-MP4 (ftyp box at offset 4)', () => {
  const buf = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x20]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(8, 0)]);
  assert.strictEqual(detectKind(buf), 'mp4-iso');
  assert.strictEqual(isVideoLikeKind('mp4-iso'), true);
});

test('detectKind recognizes Matroska / WebM EBML header', () => {
  const buf = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x01, 0x00]);
  assert.strictEqual(detectKind(buf), 'matroska');
  assert.strictEqual(isVideoLikeKind('matroska'), true);
});

test('detectKind recognizes AVI (RIFF...AVI )', () => {
  const buf = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('AVI ', 'ascii')]);
  assert.strictEqual(detectKind(buf), 'avi');
});

test('detectKind recognizes FLV', () => {
  const buf = Buffer.concat([Buffer.from('FLV', 'ascii'), Buffer.from([0x01])]);
  assert.strictEqual(detectKind(buf), 'flv');
});

test('detectKind recognizes ASF (WMV)', () => {
  const buf = Buffer.from([0x30, 0x26, 0xB2, 0x75, 0x00, 0x00]);
  assert.strictEqual(detectKind(buf), 'asf-wmv');
});

test('detectKind recognizes MPEG-PS (00 00 01 BA)', () => {
  const buf = Buffer.from([0x00, 0x00, 0x01, 0xBA, 0x00]);
  assert.strictEqual(detectKind(buf), 'mpeg-ps');
});

test('detectKind recognizes JPEG (non-video)', () => {
  const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
  assert.strictEqual(detectKind(buf), 'jpeg');
  assert.strictEqual(isVideoLikeKind('jpeg'), false);
});

test('detectKind recognizes HTML response (non-video)', () => {
  const buf = Buffer.from('<!DOCTYPE html><html><head>', 'ascii');
  assert.strictEqual(detectKind(buf), 'html');
  assert.strictEqual(isVideoLikeKind('html'), false);
});

test('detectKind returns empty for zero-length and unknown for noise', () => {
  assert.strictEqual(detectKind(Buffer.alloc(0)), 'empty');
  assert.strictEqual(detectKind(Buffer.from([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF])), 'unknown');
});

test('probeFileHead reads first bytes and returns hex + kind for an MP4-like file', async () => {
  const mp4Head = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x20]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(16, 0xAA)]);
  const p = tmpWrite('fake.mp4', mp4Head);
  try {
    const res = await probeFileHead(p, 64);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.kind, 'mp4-iso');
    assert.strictEqual(res.isVideoLike, true);
    assert.ok(res.headHex.startsWith('0000002066747970'));
    assert.strictEqual(res.bytesRead, mp4Head.length);
  } finally {
    fs.unlinkSync(p);
  }
});

test('probeFileHead returns ok:false with kind=unreadable for missing file', async () => {
  const res = await probeFileHead(path.join(os.tmpdir(), `does-not-exist-${Date.now()}.mp4`), 32);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.kind, 'unreadable');
  assert.ok(res.error);
});

test('summarizeFileStat returns size + mtime for a real file', () => {
  const p = tmpWrite('stat.bin', Buffer.alloc(123, 0xCC));
  try {
    const stat = summarizeFileStat(p);
    assert.strictEqual(stat.size, 123);
    assert.strictEqual(stat.isFile, true);
    assert.ok(stat.mtime);
  } finally {
    fs.unlinkSync(p);
  }
});

test('summarizeFileStat returns error for missing file', () => {
  const stat = summarizeFileStat(path.join(os.tmpdir(), `does-not-exist-${Date.now()}.bin`));
  assert.ok(stat.error);
});

test('detectKind requires TS sync-byte periodicity — GIF and G-prefixed text are NOT mpeg-ts', () => {
  const ts = Buffer.alloc(377, 0xFF);
  ts[0] = 0x47; ts[188] = 0x47; ts[376] = 0x47;
  assert.strictEqual(detectKind(ts), 'mpeg-ts');
  assert.strictEqual(isVideoLikeKind('mpeg-ts'), true);

  const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(400, 0x00)]);
  assert.strictEqual(detectKind(gif), 'gif');
  assert.strictEqual(isVideoLikeKind('gif'), false);

  const gText = Buffer.concat([Buffer.from('Gewinnerliste 2026\n', 'ascii'), Buffer.alloc(400, 0x20)]);
  assert.notStrictEqual(detectKind(gText), 'mpeg-ts');
  assert.strictEqual(isVideoLikeKind(detectKind(gText)), false);
});
