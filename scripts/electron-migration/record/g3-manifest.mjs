// Final-report input seal, not a recording receipt. Counts are unique trace references
// in compare artifacts, never progress counters. The recording revision is established
// only through the run's RECORDING.json / host-receipt.json / worker receipts / A store
// references (g3-provenance.mjs), which the seal includes; it cannot be established for old runs.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { readEvidence } from './json.mjs';
import { runProvenance } from './g3-provenance.mjs';
import { normalizerSha256 } from './g3-normalize.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const MANIFEST_SCHEMA = 'g3-run-manifest/v1';
export const NORMALIZER = 'scripts/electron-migration/record/g3-normalize.mjs';
export const BATCH = 'scripts/electron-migration/record/g3-batch.mjs';
export const APPROVALS = 'fixtures/differential/g3/normalize-approvals.json';
const posix = value => value.split('\\').join('/');
const sorted = values => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

function files(root, dir, accept) {
  const result = [];
  for (const entry of readdirSync(isAbsolute(dir) ? dir : join(root, dir), { withFileTypes: true })) {
    const path = posix(join(dir, entry.name));
    if (entry.isDirectory()) {
      if (!['node_modules', '.git', 'target', '.tmp'].includes(entry.name)) result.push(...files(root, path, accept));
    } else if (accept(path)) result.push(path);
  }
  return sorted(result);
}

export function compareFiles(root, runsDir) {
  // A final report consumes the active compare directory only, not trial or
  // compare.pre-final-* archives that happen to be below the run directory.
  return files(root, join(runsDir, 'compare'), path => /\.compare\.json(\.gz)?$/.test(path))
    .map(file => isAbsolute(file) ? posix(relative(root, file)) : file);
}

export function manifestHead(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Length-delimited path + original bytes, in path order (includes provider sidecars). */
export function scenarioTree(root, suites) {
  const paths = new Set(suites.map(suite => suite.file));
  for (const dir of ['host', 'electron']) {
    for (const file of files(root, dir, path => /\/equivalence\/.*\.json$/.test(path))) paths.add(file);
  }
  const digest = createHash('sha256');
  for (const file of sorted(paths)) {
    const bytes = readFileSync(join(root, file));
    digest.update(`${Buffer.byteLength(file)}:${file}:${bytes.length}:`).update(bytes);
  }
  return { sha256: digest.digest('hex'), files: sorted(paths) };
}

export function createRunManifest(root, runsDir, suites) {
  const tree = scenarioTree(root, suites);
  const sides = Object.fromEntries(['A', 'A2', 'B'].map(side => [side, new Map()]));
  const compares = compareFiles(root, runsDir).map(file => {
    const { bytes, text } = readEvidence(isAbsolute(file) ? file : join(root, file));
    const artifact = JSON.parse(text);
    for (const side of Object.keys(sides)) {
      const trace = artifact.traces?.[side];
      if (!trace) continue;
      const previous = sides[side].get(trace.file);
      if (previous && previous !== trace.sha256) throw new Error(`conflicting ${side} trace hash: ${trace.file}`);
      sides[side].set(trace.file, trace.sha256);
    }
    return { file: posix(relative(root, isAbsolute(file) ? file : join(root, file))), sha256: hash(bytes) };
  });
  const { defects, recording, workerReceipts, aRefs } = runProvenance(root, runsDir);
  return {
    schema: MANIFEST_SCHEMA, head: manifestHead(root),
    scenarioTreeSha256: tree.sha256, scenarioFiles: tree.files,
    batchVersion: hash(readFileSync(join(root, BATCH))),
    normalizerSha256: normalizerSha256(root),
    approvalsSha256: hash(readFileSync(join(root, APPROVALS))),
    countBasis: 'unique trace references in active compare artifacts; not recorded-scenario totals',
    recordingRevision: defects.length ? 'not-established-by-this-manifest' : recording.bHead,
    recording: { ...(recording ?? { file: null }), defects, workerReceipts, aRefs },
    sides: Object.fromEntries(Object.entries(sides).map(([side, refs]) => [side, {
      count: refs.size, tracesSha256: hash(JSON.stringify(sorted(refs.keys()).map(file => ({ file, sha256: refs.get(file) })))),
    }])),
    compares,
  };
}

export function verifyRunManifest(root, runsDir, suites, file = join(runsDir, 'RUN-MANIFEST.json')) {
  const bytes = readFileSync(isAbsolute(file) ? file : join(root, file));
  const recorded = JSON.parse(bytes);
  const current = createRunManifest(root, runsDir, suites);
  for (const key of Object.keys(current)) {
    if (JSON.stringify(recorded[key]) !== JSON.stringify(current[key])) throw new Error(`RUN-MANIFEST mismatch: ${key}`);
  }
  return { file: posix(relative(root, isAbsolute(file) ? file : join(root, file))), sha256: hash(bytes), ...current };
}
