// Narrow WP-200 real-Host observation. Uses X7 execution and X3 full-DB capture;
// it does not implement repositories, generate an oracle, or run Rust/Electron UI.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: WP-200 B-only observation installs the real notes owner plugin, not an implementation substitute.
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: WP-200 B-only observation installs the real vfsRepo owner including folder deletion cascade.
import reposPlugin from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: WP-200 B-only observation installs the real vfsIndex dependency of the production VFS plugin.
import indexPlugin from '../../vfs-index/index.ts';
import plugin from '../index.ts';
import { snapshotDirectory } from '../../../e2e/data-compat/__fixtures__/database-state.ts';
import { executeScenario } from '../../../../scripts/electron-migration/record/scenario-v0.mjs';
import { corpus, summary } from './check-folders.mjs';

// Explicit unique output directory: reruns preserve the earlier observations.
const output = resolve(process.argv[2]);
assert(output.startsWith(resolve('host/plugins/vfs/equivalence/raw') + '/'));
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, 'isolated-'));
const template = join(root, 'template');
const storage = createStorageService({ baseDir: template, dataLocalDir: template });
try {
  const migration = await storage.migrations.runAll();
  assert.equal(migration.success, true, migration.error);
} finally { storage.dispose(); }

const results = [];
try {
  for (const scenario of corpus.scenarios) {
    const directory = join(root, scenario.id);
    cpSync(template, directory, { recursive: true });
    const storage = createStorageService({ baseDir: directory, dataLocalDir: directory });
    let host;
    try {
      host = await createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin],
        provide: { storage }, app: { dataDir: directory } });
      const logs = [];
      host.ctx.logger.exporter({ levels: { default: 3 }, export: message => { logs.push(message); } });
      let sequence = 0;
      const observation = await executeScenario(scenario, {
        async invoke(cmd, argsRaw) {
          const outcome = await host.runtime.dispatchInvoke({ id: `wp200-${sequence++}`, cmd,
            args: JSON.parse(argsRaw), argsJson: argsRaw, source: { window: 'main', webview: 'main' } });
          assert.notEqual(outcome.kind, 'panic', `${scenario.id}: handler panic`);
          return { kind: outcome.kind === 'ok' ? 'result' : 'error',
            raw: outcome.json ?? JSON.stringify(outcome.kind === 'ok' ? outcome.value : outcome.error) };
        },
        async capture(request) {
          assert.deepEqual(request, { events: true, db: ['*'] });
          const databases = snapshotDirectory(directory).databases;
          assert(Object.keys(databases).some(file => file.endsWith('/vfs.db')), 'missing migrated vfs DB');
          return { events: structuredClone(host.events), databases };
        },
      });
      // Preserve all actual outcomes before checking annotations. A is still the oracle.
      writeFileSync(join(output, `${scenario.id}.json.gz`), gzipSync(JSON.stringify({
        ...observation, hostLogs: logs, evidence: 'real Host kernel; B-only; no A comparison',
      })), { flag: 'wx' });
      const mismatches = observation.calls.flatMap((call, index) =>
        call.outcome.kind === (scenario.steps[index].expect === 'error' ? 'error' : 'result')
          ? [] : [{ index, actual: call.outcome }]);
      results.push({ id: scenario.id, steps: observation.calls.length, mismatches,
        errors: observation.calls.filter(call => call.outcome.kind === 'error').length });
      process.stdout.write(JSON.stringify(results.at(-1)) + '\n');
    } finally {
      await host?.dispose();
      storage.dispose();
    }
  }
  const report = { ...summary, runtime: process.versions, results,
    passed: results.filter(result => result.mismatches.length === 0).length,
    failed: results.filter(result => result.mismatches.length !== 0).length, skipped: 0 };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  assert.equal(report.failed, 0, 'B outcomes differ from source-derived intent; see raw evidence');
  process.stdout.write(`Host observations: ${report.passed} passed / ${report.failed} failed / 0 skipped; ${summary.steps} calls; A/B comparison not run\n`);
} finally { rmSync(root, { recursive: true, force: true }); }
