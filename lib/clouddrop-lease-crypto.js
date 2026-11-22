const { createCipheriv } = require('node:crypto');

const FIRST_SEGMENT = 128 * 1024;
const MAX_SEGMENT = 1024 * 1024;
const MAC_SLICE = 256 * 1024;

function segmentLengths(size) {
  const lengths = [];
  let position = 0;
  let next = FIRST_SEGMENT;
  while (position < size) {
    const length = Math.min(next, size - position);
    lengths.push(length);
    position += length;
    if (next < MAX_SEGMENT) next = Math.min(MAX_SEGMENT, next + FIRST_SEGMENT);
  }
  return lengths;
}

function endsOnSegmentBoundary(size) {
  let position = 0;
  let next = FIRST_SEGMENT;
  while (position + next < size) {
    position += next;
    if (next < MAX_SEGMENT) next = Math.min(MAX_SEGMENT, next + FIRST_SEGMENT);
  }
  return Math.ceil((size - position) / 16) * 16 === next;
}

function planChunks(size, targetBytes) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new TypeError('size must be a positive integer');
  const target = Math.max(FIRST_SEGMENT, Math.floor(targetBytes));
  const segments = segmentLengths(size);
  const chunks = [];
  let offset = 0;
  let current = null;
  for (const length of segments) {
    if (!current) current = { index: chunks.length, offset, length: 0, segments: [] };
    current.segments.push(length);
    current.length += length;
    offset += length;
    if (current.length >= target) {
      chunks.push(current);
      current = null;
    }
  }
  if (current) chunks.push(current);
  return { chunks, trailingMac: endsOnSegmentBoundary(size) };
}

function ctrIv(nonce, offset) {
  if (offset % 16 !== 0) throw new RangeError('chunk offset must be a multiple of 16');
  const iv = Buffer.alloc(16);
  nonce.copy(iv, 0, 0, 8);
  iv.writeBigUInt64BE(BigInt(offset / 16), 8);
  return iv;
}

function encryptChunk({ aesKey, nonce, offset, data, segments }) {
  const key = Buffer.from(aesKey);
  const iv8 = Buffer.from(nonce);
  const plain = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const cipher = createCipheriv('aes-128-ctr', key, ctrIv(iv8, offset)).update(plain);
  const macIv = Buffer.alloc(16);
  iv8.copy(macIv, 0, 0, 8);
  iv8.copy(macIv, 8, 0, 8);
  const macs = Buffer.alloc(16 * segments.length);
  let position = 0;
  for (let s = 0; s < segments.length; s++) {
    const end = position + segments[s];
    const cbc = createCipheriv('aes-128-cbc', key, macIv).setAutoPadding(false);
    const fullEnd = position + Math.floor(segments[s] / 16) * 16;
    let last = null;
    for (let cursor = position; cursor < fullEnd;) {
      const sliceEnd = Math.min(fullEnd, cursor + MAC_SLICE);
      const out = cbc.update(plain.subarray(cursor, sliceEnd));
      last = out.subarray(out.length - 16);
      cursor = sliceEnd;
    }
    if (fullEnd < end) {
      const padded = Buffer.alloc(16);
      plain.copy(padded, 0, fullEnd, end);
      last = cbc.update(padded);
    }
    last.copy(macs, s * 16);
    position = end;
  }
  if (position !== plain.length) throw new RangeError('segment lengths do not cover the chunk');
  return { cipher, macs };
}

function condenseMacs(aesKey, segmentMacs, { trailingMac = false, nonce = null } = {}) {
  const ecb = createCipheriv('aes-128-ecb', Buffer.from(aesKey), null).setAutoPadding(false);
  const items = [...segmentMacs];
  if (trailingMac) {
    const iv = Buffer.alloc(16);
    Buffer.from(nonce).copy(iv, 0, 0, 8);
    Buffer.from(nonce).copy(iv, 8, 0, 8);
    items.push(iv);
  }
  let mac = Buffer.alloc(16, 0);
  for (const item of items) {
    for (let offset = 0; offset < item.length; offset += 16) {
      for (let j = 0; j < 16; j++) mac[j] ^= item[offset + j];
      mac = ecb.update(mac);
    }
  }
  const out = Buffer.alloc(8);
  out.writeInt32BE(mac.readInt32BE(0) ^ mac.readInt32BE(4), 0);
  out.writeInt32BE(mac.readInt32BE(8) ^ mac.readInt32BE(12), 4);
  return out;
}

function e64(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function d64(value) {
  return Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

module.exports = { segmentLengths, endsOnSegmentBoundary, planChunks, encryptChunk, condenseMacs, e64, d64 };
