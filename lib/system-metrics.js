const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const { runtimePerformance } = require('./performance-monitor');

const WINDOWS_PROBE = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $d=@(Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk | ForEach-Object { @{ Name=$_.Name; Timestamp_PerfTime=[string]$_.Timestamp_PerfTime; Frequency_PerfTime=[string]$_.Frequency_PerfTime; Timestamp_Sys100NS=[string]$_.Timestamp_Sys100NS; PercentIdleTime=[string]$_.PercentIdleTime; DiskReadBytesPersec=[string]$_.DiskReadBytesPersec; DiskWriteBytesPersec=[string]$_.DiskWriteBytesPersec; DiskReadsPersec=[string]$_.DiskReadsPersec; DiskWritesPersec=[string]$_.DiskWritesPersec; CurrentDiskQueueLength=[string]$_.CurrentDiskQueueLength } }); $v=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{ DeviceID=$_.DeviceID; Size=[string]$_.Size; FreeSpace=[string]$_.FreeSpace } }); @{disks=$d;volumes=$v} | ConvertTo-Json -Depth 4 -Compress";

async function readWindowsCounters({ runner = promisify(execFile), signal } = {}) {
  const started = performance.now();
  let request;
  try {
    request = runner('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROBE],
    { windowsHide: true, shell: false, timeout: 8000, maxBuffer: 1024 * 1024, encoding: 'utf8', signal });
  } finally {
    runtimePerformance.record('host.spawn.sync', performance.now() - started);
  }
  const { stdout } = await request;
  const value = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  if (!Array.isArray(value.disks) || !Array.isArray(value.volumes) || value.disks.length > 256 || value.volumes.length > 256) throw Error('INVALID_METRICS');
  return value;
}

function counter(value) {
  return /^\d{1,24}$/.test(String(value)) ? BigInt(value) : null;
}

function delta(current, previous) {
  const a = counter(current), b = counter(previous);
  return a !== null && b !== null && a >= b ? Number(a - b) : null;
}

function diskSample(current, previous) {
  const ticks = delta(current.Timestamp_PerfTime, previous?.Timestamp_PerfTime);
  const frequency = Number(current.Frequency_PerfTime);
  const seconds = ticks > 0 && frequency > 0 ? ticks / frequency : null;
  const rate = key => {
    const difference = delta(current[key], previous?.[key]);
    return seconds && difference !== null ? difference / seconds : null;
  };
  const idle = delta(current.PercentIdleTime, previous?.PercentIdleTime);
  const time = delta(current.Timestamp_Sys100NS, previous?.Timestamp_Sys100NS);
  const read = rate('DiskReadBytesPersec'), write = rate('DiskWriteBytesPersec');
  const readTotal = counter(current.DiskReadBytesPersec), writeTotal = counter(current.DiskWriteBytesPersec);
  return {
    id: String(current.Name).slice(0, 256), intervalMs: seconds ? seconds * 1000 : null,
    readBytesPerSecond: read, writeBytesPerSecond: write, totalBytesPerSecond: read !== null && write !== null ? read + write : null,
    readOperationsPerSecond: rate('DiskReadsPersec'), writeOperationsPerSecond: rate('DiskWritesPersec'),
    readBytesTotal: readTotal?.toString() ?? null, writeBytesTotal: writeTotal?.toString() ?? null,
    totalBytes: readTotal !== null && writeTotal !== null ? (readTotal + writeTotal).toString() : null,
    busyPercent: time > 0 && idle !== null ? Math.max(0, Math.min(100, (1 - idle / time) * 100)) : null,
    queueLength: counter(current.CurrentDiskQueueLength) !== null ? Number(current.CurrentDiskQueueLength) : null
  };
}

class SystemMetrics {
  constructor(options = {}) {
    this.os = options.os || os;
    this.now = options.now || Date.now;
    this.processCpu = options.processCpu || process.cpuUsage;
    this.processMemory = options.processMemory || process.memoryUsage;
    this.shouldCollect = options.shouldCollect || (() => true);
    this.readDisks = options.readDisks || (process.platform === 'win32' ? readWindowsCounters : null);
    this.limit = Math.max(1, Math.min(60, options.limit || 60));
    this.samples = [];
    this.previous = null;
    this.previousDisks = new Map();
    this.storage = { available: false, sampledAt: null, disks: [], volumes: [] };
    this.stopped = false;
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    void this.sample();
    this.timer = setInterval(() => { void this.sample(); }, 10000);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort();
  }

  sample() {
    if (this.pending) return this.pending;
    if (this.stopped || !this.shouldCollect()) return Promise.resolve();
    this.pending = this.capture().finally(() => { this.pending = null; });
    return this.pending;
  }

  async capture() {
    const startedAt = this.now();
    this.controller = new AbortController();
    let available = false;
    try {
      if (this.readDisks) {
        const raw = await this.readDisks({ signal: this.controller.signal });
        if (this.stopped) return;
        const disks = raw.disks.map(disk => diskSample(disk, this.previousDisks.get(disk.Name)));
        this.previousDisks = new Map(raw.disks.map(disk => [disk.Name, disk]));
        const volumes = raw.volumes.map(volume => {
          const total = counter(volume.Size), free = counter(volume.FreeSpace);
          const valid = total !== null && free !== null && free <= total;
          return { id: String(volume.DeviceID).slice(0, 16), totalBytes: valid ? Number(total) : null, freeBytes: valid ? Number(free) : null,
            usedBytes: valid ? Number(total - free) : null, usedPercent: valid && total > 0n ? Number(total - free) / Number(total) * 100 : null };
        });
        this.storage = { sampledAt: this.now(), disks, volumes };
        available = true;
      }
    } catch {}
    if (this.stopped) return;
    const now = this.now(), cpus = this.os.cpus();
    const totals = cpus.reduce((sum, cpu) => {
      sum.idle += cpu.times.idle;
      sum.total += Object.values(cpu.times).reduce((a, b) => a + b, 0);
      return sum;
    }, { idle: 0, total: 0 });
    const cpu = this.processCpu(), memory = this.processMemory();
    const elapsed = this.previous ? now - this.previous.at : null;
    const totalDelta = this.previous && totals.total - this.previous.totals.total;
    const cpuDelta = this.previous && cpu.user + cpu.system - this.previous.cpu.user - this.previous.cpu.system;
    const totalMemory = this.os.totalmem(), freeMemory = this.os.freemem();
    const sample = {
      at: now, intervalMs: elapsed, collectionDurationMs: now - startedAt,
      system: { logicalCpuCount: cpus.length, cpuPercent: totalDelta > 0 ? Math.max(0, Math.min(100, 100 * (1 - (totals.idle - this.previous.totals.idle) / totalDelta))) : null,
        memory: { totalBytes: totalMemory, freeBytes: freeMemory, usedBytes: totalMemory - freeMemory, usedPercent: totalMemory > 0 ? (totalMemory - freeMemory) / totalMemory * 100 : null }, uptimeSeconds: this.os.uptime() },
      process: { cpuPercentOneCore: elapsed > 0 && cpuDelta >= 0 ? cpuDelta / (elapsed * 10) : null, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed ?? null, heapTotalBytes: memory.heapTotal ?? null, externalBytes: memory.external ?? null },
      storage: { ...this.storage, available, stale: !available, error: available ? null : this.readDisks ? 'STORAGE_METRICS_UNAVAILABLE' : 'STORAGE_METRICS_UNSUPPORTED' }
    };
    this.previous = { at: now, totals, cpu };
    this.samples.push(sample);
    if (this.samples.length > this.limit) this.samples.shift();
  }

  snapshot({ limit = 1 } = {}) {
    const now = this.now(), latest = this.samples.at(-1) || null;
    const requested = Math.max(1, Math.min(60, limit));
    const samples = [];
    let bytes = 0;
    for (const sample of this.samples.slice(-requested).reverse()) {
      bytes += Buffer.byteLength(JSON.stringify(sample));
      if (bytes > 384 * 1024) break;
      samples.unshift(sample);
    }
    return { at: now, intervalMs: 10000, collecting: !!this.pending, stale: !latest || now - latest.at > 30000,
      ageMs: latest ? now - latest.at : null, latest, samples, returnedSamples: samples.length,
      truncated: samples.length < Math.min(requested, this.samples.length),
      notes: ['System CPU is normalized to 0–100%; process CPU uses one logical core as 100%.', 'Storage counters cover the whole system, not only this application. Byte totals are cumulative provider counters encoded as decimal strings.', 'Null rates require another valid sample. Missing or stale samples are not evidence of a freeze.'] };
  }
}

module.exports = { SystemMetrics, diskSample, readWindowsCounters };
