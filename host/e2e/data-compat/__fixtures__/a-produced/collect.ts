#!/usr/bin/env node
// Freeze the A producer run (producers.v0.json via g3-run-a.mjs, no --compact) into a fixture directory.
//   node host/e2e/data-compat/__fixtures__/a-produced/collect.ts --run DIR --receipt RECEIPT --out DIR [--zips DIR] [--take A1]
//   --local-check --take B: exercise the pipeline on a B run; the result is never offered as a seed.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { collectAProduced } from '../a-produced-seeds.ts';
import { ROOT } from '../fixtures.ts';

const { values } = parseArgs({ options: { run: { type: 'string' }, receipt: { type: 'string' }, out: { type: 'string' },
  zips: { type: 'string' }, take: { type: 'string' }, 'local-check': { type: 'boolean' } } });
if (!values.run || !values.out) throw new Error('usage: collect.ts --run DIR --receipt RECEIPT --out DIR [--zips DIR] [--take A1] [--local-check]');
const treeCommit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const provenance = collectAProduced({ runOutput: resolve(values.run), receiptFile: values.receipt && resolve(values.receipt),
  outDir: resolve(values.out), zipsDir: values.zips && resolve(values.zips), take: values.take, localCheck: values['local-check'],
  treeCommit, root: ROOT });
process.stdout.write(`${JSON.stringify({ seeds: provenance.seeds, take: provenance.take, backupId: provenance.fullBackup?.backupId ?? null,
  files: provenance.fullBackup?.files.length ?? 0, zips: provenance.zips ? Object.keys(provenance.zips) : [],
  auditRows: provenance.audit?.rows.length ?? 0, auditShapeMismatches: provenance.audit?.mismatches ?? null })}\n`);
