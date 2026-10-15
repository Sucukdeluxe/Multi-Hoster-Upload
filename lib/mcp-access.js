const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');

class McpAccessError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function validateInput(value, schema, depth = 0) {
  if (depth > 12) throw new McpAccessError('INVALID_ARGUMENTS');
  if (schema.enum && !schema.enum.includes(value)) throw new McpAccessError('INVALID_ARGUMENTS');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new McpAccessError('INVALID_ARGUMENTS');
    const keys = Object.keys(value);
    if (keys.length > 100 || keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new McpAccessError('INVALID_ARGUMENTS');
    for (const key of schema.required || []) if (!own(value, key)) throw new McpAccessError('INVALID_ARGUMENTS');
    for (const key of keys) {
      if (!own(schema.properties || {}, key)) throw new McpAccessError('INVALID_ARGUMENTS');
      validateInput(value[key], schema.properties[key], depth + 1);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems ?? 1000) || value.length < (schema.minItems ?? 0)) throw new McpAccessError('INVALID_ARGUMENTS');
    for (const entry of value) validateInput(entry, schema.items, depth + 1);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > (schema.maxLength ?? 4096) || value.length < (schema.minLength ?? 0) || value.includes('\0')) throw new McpAccessError('INVALID_ARGUMENTS');
    if (schema.pattern === '^[A-Za-z0-9_.:-]+$' && !/^[A-Za-z0-9_.:-]+$/.test(value)) throw new McpAccessError('INVALID_ARGUMENTS');
    if (schema.pattern === '^[A-Za-z0-9]+$' && !/^[A-Za-z0-9]+$/.test(value)) throw new McpAccessError('INVALID_ARGUMENTS');
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (!Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new McpAccessError('INVALID_ARGUMENTS');
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new McpAccessError('INVALID_ARGUMENTS');
  } else throw new McpAccessError('INVALID_ARGUMENTS');
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function actionDigest(name, args) { return createHash('sha256').update(canonical({ name, args })).digest('hex'); }

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

async function resolveGrantedFile(grants, rootId, relativePath, options = {}) {
  const grant = grants.find(entry => entry.id === rootId && entry.enabled !== false);
  if (!grant || (options.write && grant.readOnly !== false)) throw new McpAccessError('PATH_NOT_GRANTED');
  if (typeof relativePath !== 'string' || relativePath.includes('\0') || path.isAbsolute(relativePath)
    || /(?:^|[\\/])\.\.(?:[\\/]|$)|:/.test(relativePath)) throw new McpAccessError('PATH_NOT_GRANTED');
  const realRoot = await fs.realpath(grant.path);
  const expectedRoot = path.resolve(grant.path);
  if (process.platform === 'win32' ? realRoot.toLowerCase() !== expectedRoot.toLowerCase() : realRoot !== expectedRoot) throw new McpAccessError('PATH_NOT_GRANTED');
  const target = path.resolve(realRoot, relativePath || '.');
  if (!within(realRoot, target)) throw new McpAccessError('PATH_NOT_GRANTED');
  const realTarget = await fs.realpath(target);
  if (!within(realRoot, realTarget)) throw new McpAccessError('PATH_NOT_GRANTED');
  const stat = await fs.stat(realTarget);
  if (options.regularFile && !stat.isFile()) throw new McpAccessError('NOT_A_FILE');
  return { path: realTarget, stat, root: realRoot };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

module.exports = { McpAccessError, validateInput, actionDigest, canonical, resolveGrantedFile, safeEqual };
