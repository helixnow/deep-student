/** Seed determinism as the G3 input fingerprint defines it (g3-inputs.mjs `seedDirectoryDigest`); keep the two in step. */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { compareDatabaseStates, enumerateDatabases, snapshotDirectory } from './database-state.ts';

export interface TimedBuild { directory: string; from: number; to: number }
export function timedBuild(build: () => string): TimedBuild {
  const from = Date.now();
  const directory = build();
  return { directory, from, to: Date.now() };
}

const CLOCK_TEXT = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/;
function buildClock(cell: unknown, build: TimedBuild): boolean {
  const low = Math.floor(build.from / 1000) * 1000 - 1000, high = build.to + 1000;
  const { storageClass, value } = (cell ?? {}) as { storageClass?: string; value?: string };
  if (storageClass === 'text') {
    const match = CLOCK_TEXT.exec(value ?? '');
    if (!match) return false;
    const zone = match[4] ? match[4].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2') : 'Z';
    const time = Date.parse(`${match[1]}T${match[2]}${(match[3] ?? '').slice(0, 4)}${zone}`);
    return time >= low && time <= high;
  }
  if (storageClass === 'integer') {
    const n = Number(value);
    return (n >= low && n <= high) || (n * 1000 >= low && n * 1000 <= high);
  }
  return false;
}

function entries(directory: string): Map<string, Buffer | null> {
  const databases = new Set(enumerateDatabases(directory)), out = new Map<string, Buffer | null>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name), name = relative(directory, path).split(sep).join('/');
      if (entry.isDirectory()) { out.set(`${name}/`, null); walk(path); }
      else if (entry.isSymbolicLink()) out.set(name, Buffer.from(`symlink:${readlinkSync(path)}`));
      else if (!entry.isFile()) out.set(name, Buffer.from('special'));
      else if (!databases.has(name)) out.set(name, readFileSync(path));
    }
  };
  walk(directory);
  return out;
}

/** Everything that would still differ between two builds after build-clock cells are masked; [] = same fingerprint. */
export function seedFingerprintDifferences(a: TimedBuild, b: TimedBuild): string[] {
  const out: string[] = [];
  for (const d of compareDatabaseStates(snapshotDirectory(a.directory), snapshotDirectory(b.directory))) {
    if (d.kind === 'value' && buildClock(d.before, a) && buildClock(d.after, b)) continue;
    out.push(`${d.kind} ${d.db}${d.table ? ` ${d.table}` : ''}${d.column ? `.${d.column}` : ''}`);
  }
  const left = entries(a.directory), right = entries(b.directory);
  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const l = left.get(name), r = right.get(name);
    if (!left.has(name) || !right.has(name) || (l && r && !l.equals(r))) out.push(`file ${name}`);
  }
  return out;
}
