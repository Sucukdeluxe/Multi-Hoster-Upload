const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { McpAccessError } = require('./mcp-access');

const VERSION = /^\d+\.\d+\.\d+$/;
const TERMINAL = new Set(['completed', 'failed']);

class McpUpdate {
  constructor(options) {
    this.options = options;
    this.file = path.join(options.directory, 'mcp-update-jobs.json');
    this.jobs = [];
    this.writes = Promise.resolve();
    this.task = null;
    this.resumeTask = null;
    this.ready = false;
  }
  async load() {
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('invalid');
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.jobs) || value.jobs.length > 20
        || value.jobs.some(job => !job || !VERSION.test(job.targetVersion) || !/^[a-f0-9]{64}$/.test(job.owner) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(job.requestKey))) throw new Error('invalid');
      this.jobs = value.jobs;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new McpAccessError('UPDATE_STORE_UNAVAILABLE');
    }
    this.ready = true;
  }
  async save() {
    const data = JSON.stringify({ version: 1, jobs: this.jobs });
    if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw new McpAccessError('UPDATE_STORE_LIMIT');
    const operation = this.writes.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(data);
        await handle.sync();
        await handle.close(); handle = null;
        await fs.rename(temporary, this.file);
      } finally {
        await handle?.close();
        await fs.unlink(temporary).catch(() => {});
      }
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
  owner(context) { return createHash('sha256').update(context.principalId).digest('hex'); }
  active() { return this.jobs.find(job => !TERMINAL.has(job.phase)); }
  blocksTransfers() { const job = this.active(); return !!job && job.phase !== 'awaiting_reconnect'; }
  public(job) {
    if (!job) return null;
    const { owner: _owner, requestKey: _key, resume: _resume, ...value } = job;
    return value;
  }
  status(args, context) {
    const job = args.jobId ? this.jobs.find(item => item.id === args.jobId) : this.jobs.at(-1);
    if (job && job.owner !== this.owner(context)) throw new McpAccessError('UPDATE_NOT_FOUND');
    return { job: this.public(job) };
  }
  assertAllowed() {
    if (!this.ready) throw new McpAccessError('UPDATE_STORE_UNAVAILABLE');
    if (!this.options.canUpdate()) throw new McpAccessError('SCOPE_DENIED');
  }
  async phase(job, phase, patch = {}) {
    Object.assign(job, patch, { phase, updatedAt: Date.now() });
    await this.save();
  }
  async start({ targetVersion, requestKey }, context) {
    this.assertAllowed();
    if (!VERSION.test(targetVersion)) throw new McpAccessError('INVALID_ARGUMENTS');
    const owner = this.owner(context);
    const existing = this.jobs.find(job => job.owner === owner && job.requestKey === requestKey);
    if (existing) {
      if (existing.targetVersion !== targetVersion) throw new McpAccessError('REQUEST_CONFLICT');
      return this.public(existing);
    }
    if (this.active() || this.task) throw new McpAccessError('UPDATE_BUSY');
    if (!await this.options.supported()) throw new McpAccessError('UPDATE_INSTALLATION_UNSUPPORTED');
    this.assertAllowed();
    if (this.active()) throw new McpAccessError('UPDATE_BUSY');
    const job = { id: randomUUID(), owner, requestKey, targetVersion, sourceVersion: this.options.version(), phase: 'accepted', createdAt: Date.now(), updatedAt: Date.now() };
    const previous = this.jobs;
    this.jobs = [...this.jobs.slice(-19), job];
    try { await this.save(); }
    catch (error) { this.jobs = previous; throw error; }
    this.task = new Promise(resolve => setImmediate(resolve)).then(() => this.execute(job)).finally(() => { this.task = null; });
    return this.public(job);
  }
  async execute(job) {
    let parked = false;
    try {
      this.assertAllowed();
      await this.phase(job, 'checking');
      const release = await this.options.check();
      if (!release?.available || release.remoteVersion !== job.targetVersion) throw new McpAccessError('UPDATE_VERSION_MISMATCH');
      this.assertAllowed();
      await this.phase(job, 'downloading');
      const prepared = await this.options.prepare(release, progress => {
        job.progress = { stage: progress.stage, percent: progress.percent, bytesDownloaded: progress.bytesDownloaded, bytesTotal: progress.bytesTotal };
      });
      this.assertAllowed();
      if (prepared.remoteVersion !== job.targetVersion || !prepared.sha512Verified || !prepared.sha512) throw new McpAccessError('UPDATE_INTEGRITY_REQUIRED');
      await this.phase(job, 'waiting_uploads', { sha512: prepared.sha512 });
      job.resume = await this.options.park();
      await this.save();
      parked = true;
      await this.options.drain(() => this.assertAllowed());
      this.assertAllowed();
      await this.options.verify(prepared);
      this.assertAllowed();
      await this.phase(job, 'quiescing');
      await this.options.handoff(prepared, job);
    } catch (error) {
      const code = error instanceof McpAccessError ? error.code : 'UPDATE_FAILED';
      try {
        if (parked && job.resume) await this.options.restore(job.resume);
        await this.phase(job, 'failed', { errorCode: code, resume: null });
      } catch { job.phase = 'failed'; job.errorCode = 'UPDATE_RECOVERY_FAILED'; }
    }
  }
  async markLaunching() {
    const job = this.active();
    if (!job || job.phase !== 'quiescing') throw new McpAccessError('UPDATE_STATE_INVALID');
    this.assertAllowed();
    await this.phase(job, 'awaiting_restart');
  }
  async launchFailed() {
    const job = this.active();
    if (job) await this.phase(job, 'failed', { errorCode: 'UPDATE_LAUNCH_FAILED' });
  }
  async recover({ rendererReady, connected }) {
    if (!this.ready || this.task || this.resumeTask || !rendererReady) return;
    const job = this.active();
    if (!job) return;
    this.resumeTask = (async () => {
      if (job.phase === 'awaiting_reconnect') {
        if (connected) await this.phase(job, 'completed', { completedAt: Date.now(), reconnectedAt: Date.now() });
        return;
      }
      if (job.phase !== 'awaiting_restart' && job.phase !== 'resuming') {
        if (job.resume) await this.options.restore(job.resume);
        await this.phase(job, 'failed', { errorCode: 'UPDATE_INTERRUPTED', resume: null });
        return;
      }
      if (this.options.version() !== job.targetVersion) {
        if (job.resume) await this.options.restore(job.resume);
        await this.phase(job, 'failed', { errorCode: 'UPDATE_VERSION_NOT_INSTALLED', installedVersion: this.options.version(), resume: null });
        return;
      }
      await this.phase(job, 'resuming', { installedVersion: this.options.version() });
      if (job.resume) await this.options.restore(job.resume);
      await this.phase(job, connected ? 'completed' : 'awaiting_reconnect', { restoredAt: Date.now(), resume: null,
        ...(connected ? { completedAt: Date.now(), reconnectedAt: Date.now() } : {}) });
    })().catch(async () => { await this.phase(job, 'failed', { errorCode: 'UPDATE_RECOVERY_FAILED' }).catch(() => {}); }).finally(() => { this.resumeTask = null; });
    return this.resumeTask;
  }
}

module.exports = { McpUpdate };
