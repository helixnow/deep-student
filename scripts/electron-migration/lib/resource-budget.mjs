// Admission control, not a test exemption. Running jobs retain their original assertions.
import fs from 'node:fs';
import os from 'node:os';

export function admission(r) {
  const reasons = [];
  if (r.memAvailable < 8 * 1024 ** 3) reasons.push('available memory < 8 GiB');
  if (r.diskAvailable < 25 * 1024 ** 3) reasons.push('available disk < 25 GiB');
  // Rust-compatible sandbox NPROC=2048 counts all threads of the shared UID.
  if (r.uidThreads >= 1400) reasons.push('shared UID threads >= 1400 (sandbox headroom)');
  if (r.pressure > 40) reasons.push('CPU pressure > 40%');
  if (r.load > r.cpus * 1.4) reasons.push('load exceeds CPU budget');
  return { ok: reasons.length === 0, reasons };
}

// loadavg is host-wide, so compare it with the shared slice quota, not the calling unit's own quota
// (a 10-core G3 unit would otherwise refuse new work on a healthy host).
export function sliceCpus(read = (f) => fs.readFileSync(f, 'utf8'), fallback = os.cpus().length) {
  try {
    const [quota, period] = read('/sys/fs/cgroup/dsdev.slice/cpu.max').trim().split(/\s+/);
    if (quota !== 'max' && Number(quota) > 0 && Number(period) > 0) return Number(quota) / Number(period);
  } catch { /* no slice quota on this host */ }
  return fallback;
}

let cached;
let sampledAt = 0;
export function resources() {
  if (cached && Date.now() - sampledAt < 5000) return cached;
  const mem = fs.readFileSync('/proc/meminfo', 'utf8');
  const disk = fs.statfsSync(os.tmpdir());
  let uidThreads = 0;
  for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      if (Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) === process.getuid()) {
        uidThreads += Number(/^Threads:\s+(\d+)/m.exec(status)?.[1] ?? 1);
      }
    } catch { /* process exited during sample */ }
  }
  const pressure = fs.readFileSync('/sys/fs/cgroup/dsdev.slice/cpu.pressure', 'utf8');
  cached = {
    memAvailable: Number(/^MemAvailable:\s+(\d+)/m.exec(mem)?.[1] ?? 0) * 1024,
    diskAvailable: disk.bavail * disk.bsize,
    uidThreads,
    pressure: Number(/some avg10=([\d.]+)/.exec(pressure)?.[1] ?? 100),
    load: os.loadavg()[0], cpus: sliceCpus(),
  };
  sampledAt = Date.now();
  return cached;
}
