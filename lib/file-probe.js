const fs = require('fs');

const SIGNATURES = [
  { kind: 'mp4-iso', test: (b) => b.length >= 12 && b.slice(4, 8).toString('ascii') === 'ftyp' },
  { kind: 'matroska', test: (b) => b.length >= 4 && b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3 },
  { kind: 'avi', test: (b) => b.length >= 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'AVI ' },
  { kind: 'wav', test: (b) => b.length >= 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WAVE' },
  { kind: 'flv', test: (b) => b.length >= 3 && b.slice(0, 3).toString('ascii') === 'FLV' },
  { kind: 'asf-wmv', test: (b) => b.length >= 4 && b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xB2 && b[3] === 0x75 },
  { kind: 'mpeg-ps', test: (b) => b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && (b[3] === 0xBA || b[3] === 0xB3) },
  { kind: 'gif', test: (b) => b.length >= 6 && (b.slice(0, 6).toString('ascii') === 'GIF87a' || b.slice(0, 6).toString('ascii') === 'GIF89a') },
  // TS demands the 0x47 sync byte every 188 bytes — a single leading 0x47
  // matches every GIF and every text file starting with "G", so require
  // three consecutive packet boundaries before classifying as video.
  { kind: 'mpeg-ts', test: (b) => b.length >= 377 && b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47 },
  { kind: 'mp3', test: (b) => b.length >= 3 && (b.slice(0, 3).toString('ascii') === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)) },
  { kind: 'ogg', test: (b) => b.length >= 4 && b.slice(0, 4).toString('ascii') === 'OggS' },
  { kind: 'jpeg', test: (b) => b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { kind: 'png', test: (b) => b.length >= 8 && b[0] === 0x89 && b.slice(1, 4).toString('ascii') === 'PNG' },
  { kind: 'pdf', test: (b) => b.length >= 5 && b.slice(0, 5).toString('ascii') === '%PDF-' },
  { kind: 'zip', test: (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4B && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) },
  { kind: 'html', test: (b) => {
    const s = b.toString('ascii', 0, Math.min(b.length, 64)).trimStart().toLowerCase();
    return s.startsWith('<!doctype html') || s.startsWith('<html');
  } }
];

const VIDEO_KINDS = new Set(['mp4-iso', 'matroska', 'avi', 'flv', 'asf-wmv', 'mpeg-ps', 'mpeg-ts']);

function detectKind(buf) {
  if (!buf || buf.length === 0) return 'empty';
  for (const sig of SIGNATURES) {
    try { if (sig.test(buf)) return sig.kind; } catch { /* ignore malformed buffer slice */ }
  }
  return 'unknown';
}

function isVideoLikeKind(kind) {
  return VIDEO_KINDS.has(kind);
}

function probeFileHead(filePath, bytes) {
  const want = Number.isFinite(bytes) && bytes > 0 ? bytes : 64;
  return new Promise((resolve) => {
    fs.open(filePath, 'r', (err, fd) => {
      if (err) return resolve({ ok: false, error: err.message, kind: 'unreadable' });
      const buf = Buffer.alloc(want);
      fs.read(fd, buf, 0, want, 0, (rerr, bytesRead) => {
        fs.close(fd, () => {});
        if (rerr) return resolve({ ok: false, error: rerr.message, kind: 'unreadable' });
        const slice = buf.slice(0, bytesRead);
        resolve({
          ok: true,
          bytesRead,
          kind: detectKind(slice),
          isVideoLike: isVideoLikeKind(detectKind(slice)),
          headHex: slice.toString('hex')
        });
      });
    });
  });
}

function summarizeFileStat(filePath) {
  try {
    const st = fs.statSync(filePath);
    return {
      size: st.size,
      mtime: st.mtime.toISOString(),
      isFile: st.isFile()
    };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { detectKind, isVideoLikeKind, probeFileHead, summarizeFileStat, VIDEO_KINDS, SIGNATURES };
