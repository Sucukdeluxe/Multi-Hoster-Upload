const fs = require('node:fs/promises');
const path = require('node:path');

const HOSTERS = Object.freeze({ 'doodstream.com': 'Doodstream', 'voe.sx': 'VOE', 'vidmoly.me': 'Vidmoly', 'byse.sx': 'Byse', 'clouddrop.cc': 'CloudDrop' });
const RANGES = new Set(['session', 'today', 'last24', 'week', 'month', 'all']);
const MINUTE = 60000;
const DAY = 86400000;
const empty = () => ({ bytes: 0, trackedBytes: 0, completed: 0, failed: 0, activeMs: 0, providers: {} });
const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
const dayKey = time => {
  const date = new Date(time);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
};
function add(target, delta, hoster) {
  for (const key of ['bytes', 'trackedBytes', 'completed', 'failed', 'activeMs']) target[key] = count(target[key]) + count(delta[key]);
  if (Object.hasOwn(HOSTERS, hoster)) {
    const provider = target.providers[hoster] ||= { bytes: 0, completed: 0, failed: 0 };
    for (const key of ['bytes', 'completed', 'failed']) provider[key] += count(delta[key]);
  }
}
function merge(target, source) {
  add(target, source);
  for (const [hoster, bucket] of Object.entries(source.providers || {})) {
    if (!Object.hasOwn(HOSTERS, hoster)) continue;
    const provider = target.providers[hoster] ||= { bytes: 0, completed: 0, failed: 0 };
    for (const key of ['bytes', 'completed', 'failed']) provider[key] += count(bucket[key]);
  }
}
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validNumber(value) {
  return Number.isFinite(value) && value >= 0;
}
function validBucket(value) {
  if (!isRecord(value) || !isRecord(value.providers)) return false;
  if (!['bytes', 'completed', 'failed', 'activeMs'].every(key => validNumber(value[key]))) return false;
  if (value.trackedBytes !== undefined && !validNumber(value.trackedBytes)) return false;
  const totals = { bytes: 0, completed: 0, failed: 0 };
  for (const [hoster, bucket] of Object.entries(value.providers)) {
    if (!Object.hasOwn(HOSTERS, hoster) || !isRecord(bucket)) return false;
    for (const key of Object.keys(totals)) {
      if (!validNumber(bucket[key])) return false;
      totals[key] += bucket[key];
    }
  }
  return Object.keys(totals).every(key => totals[key] === value[key]);
}
function validState(value) {
  return value?.version === 1 && isRecord(value.days) && isRecord(value.minutes)
    && validNumber(value.startedAt) && validBucket(value.total)
    && Object.entries(value.days).every(([key, bucket]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && validBucket(bucket))
    && Object.entries(value.minutes).every(([key, bucket]) => /^\d+$/.test(key) && validBucket(bucket));
}
function applyRecord(state, sessionBucket, hoster, delta, time, session, now) {
  if (session) add(sessionBucket, delta, hoster);
  add(state.total, delta, hoster);
  add(state.days[dayKey(time)] ||= empty(), delta, hoster);
  if (time >= now - 2 * DAY) add(state.minutes[Math.floor(time / MINUTE)] ||= empty(), delta, hoster);
}

class UploadStatistics {
  constructor(filePath, { now = Date.now } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.session = empty();
    this.sessionStartedAt = now();
    this.seen = new Set();
    this.activeSince = null;
    this.writeChain = Promise.resolve();
    this.revision = 0;
    this.savedRevision = -1;
    this.ready = false;
    this.error = '';
  }

  async init(history = []) {
    let present = false;
    for (const name of [this.filePath, this.filePath + '.bak']) {
      try {
        const value = JSON.parse(await fs.readFile(name, 'utf8'));
        if (!validState(value)) throw new Error('Ungültiges Statistikformat');
        this.state = value;
        this.savedRevision = 0;
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') present = true;
      }
    }
    if (!this.state && present) throw new Error('Statistikdatei und Sicherung sind nicht lesbar');
    if (!this.state) {
      this.state = { version: 1, startedAt: this.now(), historyImported: false, total: empty(), days: {}, minutes: {} };
      for (const batch of Array.isArray(history) ? history : []) {
        const time = Date.parse(batch?.timestamp);
        if (!Number.isFinite(time) || time > this.now()) continue;
        for (const file of batch.files || []) {
          for (const result of file.results || []) {
            if (!Object.hasOwn(HOSTERS, result.hoster) || !['done', 'error'].includes(result.status)) continue;
            this.record(result.hoster, { bytes: result.status === 'done' ? count(file.size) : 0, completed: Number(result.status === 'done'), failed: Number(result.status === 'error') }, time, false);
            this.state.historyImported = true;
            this.state.startedAt = Math.min(this.state.startedAt, time);
          }
        }
      }
    }
    this.ready = true;
    await this.flush();
  }

  record(hoster, delta, time = this.now(), session = true) {
    if (session) delta = { ...delta, trackedBytes: count(delta.bytes) };
    applyRecord(this.state, this.session, hoster, delta, time, session, this.now());
    this.resetRecords?.push({ hoster, delta, time, session });
    this.revision++;
  }

  transfer(hoster, bytes) {
    if (!this.ready || !Object.hasOwn(HOSTERS, hoster) || !Number.isFinite(bytes) || bytes <= 0) return;
    this.record(hoster, { bytes });
  }

  outcome({ id, hoster, status }) {
    if (!this.ready || !id || !Object.hasOwn(HOSTERS, hoster) || !['done', 'error'].includes(status) || this.seen.has(id)) return;
    this.seen.add(id);
    this.record(hoster, { completed: Number(status === 'done'), failed: Number(status === 'error') });
  }

  activity(active) {
    if (!this.ready) return;
    const now = this.now();
    if (this.activeSince !== null) {
      let start = this.activeSince;
      while (start < now) {
        const end = Math.min(now, (Math.floor(start / MINUTE) + 1) * MINUTE);
        this.record(null, { activeMs: end - start }, start);
        start = end;
      }
    }
    this.activeSince = active ? now : null;
  }

  finishBatch() {
    this.activity(false);
    this.seen.clear();
  }

  snapshot(range = 'session') {
    if (!RANGES.has(range)) throw new Error('Ungültiger Statistikzeitraum');
    if (!this.ready) throw new Error('Statistik noch nicht verfügbar');
    this.activity(this.activeSince !== null);
    const total = empty();
    if (range === 'session') merge(total, this.session);
    else if (range === 'all') merge(total, this.state.total);
    else if (range === 'last24') {
      const cutoff = Math.floor((this.now() - DAY) / MINUTE);
      for (const [minute, bucket] of Object.entries(this.state.minutes)) if (Number(minute) > cutoff && Number(minute) <= Math.floor(this.now() / MINUTE)) merge(total, bucket);
    } else {
      const date = new Date(this.now());
      date.setDate(date.getDate() - (range === 'month' ? 29 : range === 'week' ? 6 : 0));
      const start = dayKey(date.getTime());
      const end = dayKey(this.now());
      for (const [day, bucket] of Object.entries(this.state.days)) if (day >= start && day <= end) merge(total, bucket);
    }
    const outcomes = total.completed + total.failed;
    return { ...total, range, startedAt: range === 'session' ? this.sessionStartedAt : this.state.startedAt,
      historyImported: range !== 'session' && this.state.historyImported,
      successRate: outcomes ? total.completed / outcomes * 100 : null,
      averageSpeedBps: total.activeMs > 0 ? total.trackedBytes * 1000 / total.activeMs : null,
      persistenceError: this.error,
      providers: Object.entries(HOSTERS).map(([id, label]) => ({ id, label, ...(total.providers[id] || { bytes: 0, completed: 0, failed: 0 }) })) };
  }

  reset(scope) {
    if (!['session', 'all', 'errors'].includes(scope)) return Promise.reject(new Error('Ungültiger Statistikreset'));
    if (!this.ready) return Promise.reject(new Error('Statistik noch nicht verfügbar'));
    const task = this.writeChain.catch(() => {}).then(async () => {
      this.activity(this.activeSince !== null);
      const resetAt = this.now();
      const nextState = scope === 'all'
        ? { version: 1, startedAt: resetAt, historyImported: false, total: empty(), days: {}, minutes: {} }
        : structuredClone(this.state);
      const nextSession = scope === 'session' || scope === 'all' ? empty() : structuredClone(this.session);
      if (scope === 'errors') {
        for (const bucket of [nextSession, nextState.total, ...Object.values(nextState.days), ...Object.values(nextState.minutes)]) {
          bucket.failed = 0;
          for (const provider of Object.values(bucket.providers)) provider.failed = 0;
        }
      }
      const revision = this.revision;
      this.resetRecords = [];
      try {
        await this.writePayload(JSON.stringify(nextState));
        for (const record of this.resetRecords) applyRecord(nextState, nextSession, record.hoster, record.delta, record.time, record.session, this.now());
        this.state = nextState;
        this.session = nextSession;
        if (scope === 'session' || scope === 'all') this.sessionStartedAt = resetAt;
        this.revision++;
        this.savedRevision = this.resetRecords.length ? revision : this.revision;
        this.error = '';
      } finally { this.resetRecords = null; }
    });
    this.writeChain = task;
    return task.catch(error => { this.error = 'Statistik konnte nicht gespeichert werden'; throw error; });
  }

  async writePayload(data) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const handle = await fs.open(this.filePath + '.tmp', 'w');
    try { await handle.writeFile(data, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    try {
      const previous = await fs.readFile(this.filePath, 'utf8');
      if (validState(JSON.parse(previous))) await fs.writeFile(this.filePath + '.bak', previous, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await fs.rename(this.filePath + '.tmp', this.filePath);
  }

  flush() {
    const task = this.writeChain.catch(() => {}).then(async () => {
      if (!this.ready || this.savedRevision === this.revision) return;
      const cutoff = Math.floor((this.now() - 2 * DAY) / MINUTE);
      for (const minute of Object.keys(this.state.minutes)) if (Number(minute) < cutoff) delete this.state.minutes[minute];
      const revision = this.revision;
      const data = JSON.stringify(this.state);
      await this.writePayload(data);
      this.savedRevision = revision;
      this.error = '';
    });
    this.writeChain = task;
    return task.catch(error => { this.error = 'Statistik konnte nicht gespeichert werden'; throw error; });
  }
}
module.exports = { UploadStatistics, HOSTERS };
