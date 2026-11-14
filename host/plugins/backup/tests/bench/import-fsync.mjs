// Import write-path fsync benchmark (not a vitest file):
//   node host/plugins/backup/tests/bench/import-fsync.mjs <scratch-dir> [counts=300,1000,3000] [rounds=3]
// Mirrors `extractEntryAtomically` (zip.ts): temp file 'wx' → write → fsync → close → rename, against
// deferred variants that rename first and fsync everything (files, then directories) at the end.
// Size mix: 70% 8 KiB, 25% 64 KiB, 5% 1 MiB (attachments/images); 8 subdirectories.
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const [scratch, countsArg = '300,1000,3000', roundsArg = '3'] = process.argv.slice(2);
if (!scratch) throw new Error('usage: import-fsync.mjs <scratch-dir> [counts] [rounds]');
const counts = countsArg.split(',').map(Number);
const rounds = Number(roundsArg);
const DIRS = 8;

function sizes(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = (i * 7919) % 100;
    out.push(r < 70 ? 8 << 10 : r < 95 ? 64 << 10 : 1 << 20);
  }
  return out;
}

const payload = new Uint8Array(1 << 20).map((_, i) => (i * 131 + 7) & 0xff);

async function writeTemp(destination, size) {
  const temp = `${destination}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx');
  await handle.write(payload, 0, size, 0);
  return { temp, handle };
}

async function fsyncPath(path, flags = 'r') {
  const handle = await open(path, flags);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function pool(items, limit, run) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  }));
}

const strategies = {
  async perFile(root, list) {
    for (const [destination, size] of list) {
      const { temp, handle } = await writeTemp(destination, size);
      await handle.sync();
      await handle.close();
      await rename(temp, destination);
    }
  },
  async perFileNoSync(root, list) {
    for (const [destination, size] of list) {
      const { temp, handle } = await writeTemp(destination, size);
      await handle.close();
      await rename(temp, destination);
    }
  },
  async batchSequential(root, list) {
    await strategies.perFileNoSync(root, list);
    for (const [destination] of list) await fsyncPath(destination);
    for (let d = 0; d < DIRS; d++) await fsyncPath(join(root, `d${d}`));
    await fsyncPath(root);
  },
  async batchParallel16(root, list) {
    await strategies.perFileNoSync(root, list);
    await pool(list, 16, ([destination]) => fsyncPath(destination));
    await pool(Array.from({ length: DIRS }, (_, d) => join(root, `d${d}`)), 16, dir => fsyncPath(dir));
    await fsyncPath(root);
  },
};

const results = [];
for (const count of counts) {
  const sz = sizes(count);
  const totalMiB = sz.reduce((a, b) => a + b, 0) / (1 << 20);
  for (const [name, run] of Object.entries(strategies)) {
    const times = [];
    for (let round = 0; round < rounds; round++) {
      const root = join(scratch, `${name}-${count}-${round}`);
      for (let d = 0; d < DIRS; d++) await mkdir(join(root, `d${d}`), { recursive: true });
      const list = sz.map((size, i) => [join(root, `d${i % DIRS}`, `f${i}.bin`), size]);
      const start = process.hrtime.bigint();
      await run(root, list);
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
      await rm(root, { recursive: true, force: true });
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    results.push({ count, totalMiB: Number(totalMiB.toFixed(1)), strategy: name, medianMs: Math.round(median), perFileMs: Number((median / count).toFixed(2)), runsMs: times.map(Math.round) });
    process.stderr.write(`${count} ${name} median=${Math.round(median)}ms\n`);
  }
}
process.stdout.write(`${JSON.stringify({ platform: process.platform, node: process.version, results }, null, 2)}\n`);
