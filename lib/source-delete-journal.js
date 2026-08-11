const fs = require('node:fs');
const path = require('node:path');

class SourceDeleteJournal {
  constructor(filePath, onEvent, options = {}) {
    this.filePath = filePath;
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.fs = options.fs || fs;
    this.wait = typeof options.wait === 'function' ? options.wait : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    this.pending = Promise.resolve();
  }

  append(entry) {
    const operation = this.pending.then(async () => {
      await this.fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      const handle = await this.fs.promises.open(this.filePath, 'a');
      try {
        await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  plan(entry) {
    return this.append({ action: 'plan', timestamp: new Date().toISOString(), ...entry });
  }

  clear(token) {
    return this.append({ action: 'clear', timestamp: new Date().toISOString(), token });
  }

  async recover() {
    await this.pending;
    let text;
    try {
      text = await this.fs.promises.readFile(this.filePath, 'utf-8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
    const active = new Map();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry || typeof entry.token !== 'string') continue;
        if (entry.action === 'plan') active.set(entry.token, entry);
        if (entry.action === 'clear') active.delete(entry.token);
      } catch {}
    }
    const outcomes = [];
    for (const entry of active.values()) {
      try {
        const sourceExists = await this.exists(entry.file);
        const stagedExists = await this.exists(entry.stagedFile);
        if (!sourceExists && stagedExists) {
          try {
            await this.renameWithRetries(entry.stagedFile, entry.file);
            outcomes.push({ token: entry.token, outcome: 'restored', file: entry.file });
            await this.clear(entry.token);
          } catch (error) {
            outcomes.push({ token: entry.token, outcome: 'restore-failed', file: entry.file, error: error.message });
          }
        } else if (!stagedExists) {
          outcomes.push({ token: entry.token, outcome: 'cleared', file: entry.file });
          await this.clear(entry.token);
        } else {
          outcomes.push({ token: entry.token, outcome: 'conflict', file: entry.file, stagedFile: entry.stagedFile });
        }
      } catch (error) {
        outcomes.push({ token: entry.token, outcome: 'recovery-failed', file: entry.file, error: error.message });
      }
    }
    for (const outcome of outcomes) this.onEvent(outcome);
    return outcomes;
  }

  async exists(target) {
    try {
      await this.fs.promises.lstat(target);
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async renameWithRetries(from, to) {
    const delays = [100, 250, 500];
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.fs.promises.rename(from, to);
        return;
      } catch (error) {
        if (!error || !['EBUSY', 'EPERM'].includes(error.code) || attempt >= delays.length) throw error;
        await this.wait(delays[attempt]);
      }
    }
  }
}

module.exports = SourceDeleteJournal;
