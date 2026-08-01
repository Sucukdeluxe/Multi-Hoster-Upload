function normalizeIp(ip) {
  return String(ip || '').trim().replace(/^::ffff:/i, '').toLowerCase();
}

function isLoopbackIp(ip) {
  const c = normalizeIp(ip);
  return c === '' || c === '::1' || c === 'localhost' || /^127\./.test(c);
}

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

function matchIpRule(clientIp, rule) {
  const client = normalizeIp(clientIp);
  const r = String(rule || '').trim().toLowerCase();
  if (!r) return false;
  if (r === '*' || r === '0.0.0.0/0') return true;
  if (r === client) return true;
  const slash = r.indexOf('/');
  if (slash > 0) {
    const baseInt = ipv4ToInt(r.slice(0, slash));
    const clientInt = ipv4ToInt(client);
    const bits = Number(r.slice(slash + 1));
    if (baseInt === null || clientInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
    return (clientInt & mask) === (baseInt & mask);
  }
  return false;
}

function evaluateClientAllowed(clientIp, rules) {
  const client = normalizeIp(clientIp);
  if (isLoopbackIp(client)) return true;
  const list = Array.isArray(rules) ? rules : [];
  if (list.length === 0) return false;
  return list.some((rule) => matchIpRule(client, rule));
}

module.exports = { normalizeIp, isLoopbackIp, ipv4ToInt, matchIpRule, evaluateClientAllowed };
