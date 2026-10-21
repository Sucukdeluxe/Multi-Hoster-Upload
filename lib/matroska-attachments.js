const fs = require('node:fs');

const EBML_ID = 0x1A45DFA3;
const SEGMENT_ID = 0x18538067;
const SEEK_HEAD_ID = 0x114D9B74;
const SEEK_ID = 0x4DBB;
const SEEK_ID_ID = 0x53AB;
const SEEK_POSITION_ID = 0x53AC;
const ATTACHMENTS_ID = 0x1941A469;
const CLUSTER_ID = 0x1F43B675;
const VOID_ID = 0xEC;
const MAX_TOP_LEVEL_ELEMENTS = 256;
const MAX_SEEK_HEAD_BYTES = 64 * 1024;

function readVint(buffer, offset, keepMarker) {
  const first = buffer[offset];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || offset + length > buffer.length) return null;
  let value = keepMarker ? first : first & (0xFF >> length);
  let unknown = value === (0xFF >> length);
  for (let index = 1; index < length; index++) {
    const byte = buffer[offset + index];
    value = value * 256 + byte;
    if (byte !== 0xFF) unknown = false;
  }
  return { value, length, unknown: !keepMarker && unknown };
}

function encodeVint(value, length) {
  if (!Number.isSafeInteger(value) || value < 0 || length < 1 || length > 8) return null;
  if (value >= 2 ** (7 * length) - 1) return null;
  const bytes = Buffer.alloc(length);
  let rest = value;
  for (let index = length - 1; index >= 0; index--) {
    bytes[index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  bytes[0] |= 0x80 >> (length - 1);
  return bytes;
}

function voidHeader(headerLength, payloadLength) {
  const single = encodeVint(payloadLength, headerLength - 1);
  if (single) return Buffer.concat([Buffer.from([VOID_ID]), single]);
  for (let sizeLength = 8; sizeLength >= 1; sizeLength--) {
    const filler = headerLength - 2 - 1 - sizeLength;
    if (filler < 0 || filler > 126) continue;
    const size = encodeVint(payloadLength, sizeLength);
    if (!size) continue;
    return Buffer.concat([Buffer.from([VOID_ID, 0x80 | filler]), Buffer.alloc(filler), Buffer.from([VOID_ID]), size]);
  }
  return null;
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function readElementHeader(handle, position) {
  const buffer = await readAt(handle, position, 12);
  const id = readVint(buffer, 0, true);
  if (!id || id.length > 4) return null;
  const size = readVint(buffer, id.length, false);
  if (!size) return null;
  return { id: id.value, position, headerLength: id.length + size.length, size: size.unknown ? null : size.value };
}

function seekTargets(buffer, segmentDataStart) {
  const targets = [];
  let offset = 0;
  while (offset < buffer.length) {
    const id = readVint(buffer, offset, true);
    const size = id && readVint(buffer, offset + id.length, false);
    if (!id || !size || size.unknown) break;
    const start = offset + id.length + size.length;
    const end = start + size.value;
    if (end > buffer.length) break;
    if (id.value === SEEK_ID) {
      let inner = start;
      let seekId = null;
      let seekPosition = null;
      while (inner < end) {
        const childId = readVint(buffer, inner, true);
        const childSize = childId && readVint(buffer, inner + childId.length, false);
        if (!childId || !childSize || childSize.unknown) break;
        const valueStart = inner + childId.length + childSize.length;
        const valueEnd = valueStart + childSize.value;
        if (valueEnd > end) break;
        let value = 0;
        for (let index = valueStart; index < valueEnd; index++) value = value * 256 + buffer[index];
        if (childId.value === SEEK_ID_ID) seekId = value;
        if (childId.value === SEEK_POSITION_ID) seekPosition = value;
        inner = valueEnd;
      }
      if (seekId === ATTACHMENTS_ID && Number.isSafeInteger(seekPosition)) targets.push(segmentDataStart + seekPosition);
    }
    offset = end;
  }
  return targets;
}

async function findAttachmentVoidPatches(filePath, { open = file => fs.promises.open(file, 'r') } = {}) {
  const handle = await open(filePath);
  try {
    const { size: fileSize } = await handle.stat();
    const ebml = await readElementHeader(handle, 0);
    if (!ebml || ebml.id !== EBML_ID || ebml.size === null) return [];
    const segment = await readElementHeader(handle, ebml.headerLength + ebml.size);
    if (!segment || segment.id !== SEGMENT_ID) return [];
    const segmentDataStart = segment.position + segment.headerLength;
    const segmentEnd = segment.size === null ? fileSize : Math.min(fileSize, segmentDataStart + segment.size);
    const candidates = new Set();
    let position = segmentDataStart;
    for (let count = 0; count < MAX_TOP_LEVEL_ELEMENTS && position < segmentEnd; count++) {
      const element = await readElementHeader(handle, position);
      if (!element || element.size === null || element.id === CLUSTER_ID) break;
      if (element.id === ATTACHMENTS_ID) candidates.add(position);
      if (element.id === SEEK_HEAD_ID && element.size <= MAX_SEEK_HEAD_BYTES) {
        const content = await readAt(handle, position + element.headerLength, element.size);
        for (const target of seekTargets(content, segmentDataStart)) candidates.add(target);
      }
      position += element.headerLength + element.size;
    }
    const patches = [];
    for (const candidate of [...candidates].sort((a, b) => a - b)) {
      const element = await readElementHeader(handle, candidate);
      if (!element || element.id !== ATTACHMENTS_ID || element.size === null) continue;
      if (candidate + element.headerLength + element.size > segmentEnd) continue;
      const bytes = voidHeader(element.headerLength, element.size);
      if (bytes && bytes.length === element.headerLength) patches.push({ offset: candidate, bytes });
    }
    return patches;
  } finally {
    await handle.close();
  }
}

function applyPatches(chunk, chunkOffset, patches) {
  let patched = chunk;
  for (const patch of patches) {
    const start = Math.max(patch.offset, chunkOffset);
    const end = Math.min(patch.offset + patch.bytes.length, chunkOffset + chunk.length);
    if (start >= end) continue;
    if (patched === chunk) patched = Buffer.from(chunk);
    patch.bytes.copy(patched, start - chunkOffset, start - patch.offset, end - patch.offset);
  }
  return patched;
}

module.exports = { findAttachmentVoidPatches, applyPatches, __test: { readVint, encodeVint, voidHeader } };
