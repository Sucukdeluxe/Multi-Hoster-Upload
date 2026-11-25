function parseStorageAmount(html) {
  const text = String(html).replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;|&#xA0;/gi, ' ').trim();
  const match = text.match(/^([\d.,]+)\s*(B|[KMGTPE]i?B)$/i);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) return null;
  return { value, unit: match[2].toUpperCase() };
}

function parseVoeAccountStorage(html) {
  const sidebar = String(html || '').match(/<nav\b[^>]*\bid\s*=\s*["']sidebarMenu["'][^>]*>([\s\S]*?)<\/nav\s*>/i)?.[1];
  if (!sidebar) return null;
  for (const match of sidebar.matchAll(/<small\b[^>]*>([\s\S]*?)<\/small\s*>/gi)) {
    const spans = [...match[1].matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span\s*>/gi)];
    if (spans.length !== 2 || !/\bfloat-end\b/.test(spans[1][1])) continue;
    const used = parseStorageAmount(spans[0][2]);
    const total = parseStorageAmount(spans[1][2]);
    if (used && total && total.value > 0) return { used, total, unitBase: 1024 };
  }
  return null;
}

const STORAGE_UNIT_POWERS = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4, PB: 5, PIB: 5, EB: 6, EIB: 6 };

function storageAmountBytes(amount, unitBase) {
  const power = STORAGE_UNIT_POWERS[String(amount?.unit || '').toUpperCase()];
  if (power === undefined || !Number.isFinite(amount?.value)) return null;
  return amount.value * unitBase ** power;
}

function isVoeStorageFull(storage, fileSize = 0) {
  if (!storage) return false;
  const unitBase = storage.unitBase || 1024;
  const used = storageAmountBytes(storage.used, unitBase);
  const total = storageAmountBytes(storage.total, unitBase);
  if (used === null || total === null || total <= 0) return false;
  return total - used < Math.max(1, Number(fileSize) || 0);
}

module.exports = { parseVoeAccountStorage, isVoeStorageFull };
