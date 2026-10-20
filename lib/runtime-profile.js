const { Session } = require('node:inspector');
const path = require('node:path');

function summarizeProfile(profile) {
  const nodes = new Map((profile.nodes || []).map(node => [node.id, node]));
  const parents = new Map();
  for (const node of nodes.values()) for (const child of node.children || []) parents.set(child, node.id);
  const frame = id => {
    const source = nodes.get(id)?.callFrame || {};
    return { name: String(source.functionName || '(anonymous)').slice(0, 160),
      file: path.basename(String(source.url || '').replace(/\\/g, '/').split(/[?#]/)[0]), line: (source.lineNumber ?? -1) + 1 };
  };
  const stack = id => {
    const result = [], seen = new Set();
    while (id !== undefined && !seen.has(id) && result.length < 12) {
      seen.add(id); result.push(frame(id)); id = parents.get(id);
    }
    return result;
  };
  const totals = new Map(), gaps = [];
  let elapsedMs = 0;
  for (let index = 0; index < (profile.samples || []).length; index++) {
    const id = profile.samples[index], durationMs = Math.max(0, (profile.timeDeltas?.[index] || 0) / 1000);
    elapsedMs += durationMs;
    const total = totals.get(id) || { ...frame(id), samples: 0, sampledMs: 0 };
    total.samples++; total.sampledMs += durationMs; totals.set(id, total);
    if (durationMs >= 100) gaps.push({ elapsedMs, durationMs, stack: stack(id), previousStack: stack(profile.samples[index - 1]) });
  }
  return { sampleCount: profile.samples?.length || 0, elapsedMs,
    top: [...totals.values()].sort((a, b) => b.sampledMs - a.sampledMs).slice(0, 40),
    gaps: gaps.sort((a, b) => b.durationMs - a.durationMs).slice(0, 20),
    note: 'Sampling gaps can include OS scheduling and native waits; sampled stacks alone do not prove their cause.' };
}

class RuntimeProfile {
  constructor({ createSession = () => new Session(), schedule = setTimeout, now = Date.now } = {}) {
    this.createSession = createSession; this.schedule = schedule; this.now = now;
    this.state = { status: 'idle' };
  }
  async start(seconds = 60) {
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 120) throw Error('PROFILE_DURATION');
    if (this.session) throw Error('PROFILE_BUSY');
    const session = this.createSession();
    this.session = session;
    this.state = { status: 'starting', startedAt: this.now(), seconds };
    this.post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
    try {
      session.connect();
      await this.post('Profiler.enable');
      await this.post('Profiler.setSamplingInterval', { interval: 10000 });
      await this.post('Profiler.start');
      this.state.status = 'recording';
      this.timer = this.schedule(() => this.stop(), seconds * 1000);
      this.timer.unref?.();
      return this.snapshot();
    } catch {
      session.disconnect(); this.session = null; this.state.status = 'failed';
      throw Error('PROFILE_UNAVAILABLE');
    }
  }
  async stop() {
    if (!this.session) return this.snapshot();
    const session = this.session;
    try {
      const { profile } = await this.post('Profiler.stop');
      this.state = { ...this.state, status: 'completed', completedAt: this.now(), result: summarizeProfile(profile) };
    } catch { this.state.status = 'failed'; }
    finally { session.disconnect(); this.session = null; }
    return this.snapshot();
  }
  snapshot() { return structuredClone(this.state); }
}

module.exports = { RuntimeProfile, summarizeProfile };
