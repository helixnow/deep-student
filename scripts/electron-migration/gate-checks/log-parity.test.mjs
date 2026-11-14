import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rustLogs, run, tsLogs } from './log-parity.mjs';
import { rustEvidence } from './rust-evidence.mjs';

test('Rust counts warn!/error! (qualified too) outside cfg(test) modules, ignores strings/comments', async () => {
  const fns = await rustEvidence('fn a() { warn!("x"); tracing::error!("y"); let s = "warn!(z)"; // error!(c)\n info!("i"); }\n#[cfg(test)]\nmod tests { fn t() { warn!("t"); } }');
  assert.deepEqual(rustLogs(fns), { warn: 1, error: 1 });
});
test('TS counts logger warn/error and logWarn/logError, not console or other warn methods', () => {
  const hits = tsLogs('a.ts', 'ctx.logger.warn("a"); this.log.error("b"); logWarn("c"); console.warn("d"); form.warn("e"); logger.info("f");');
  assert.deepEqual(hits.map(h => h.level), ['warn', 'error', 'warn']);
});
test('file mapping by cited Rust file; deficit is info only; changed scope', async () => {
  const root = fs.mkdtempSync('/tmp/opencode/log-parity-');
  const content = {
    'src-tauri/src/svc.rs': 'fn a() { warn!("1"); warn!("2"); error!("3"); }',
    'host/plugins/p/LANE.md': '| `src-tauri/src/svc.rs` | 1 | 0 | |',
    'host/plugins/p/src/svc.ts': '// svc.rs:1\nexport function a(log) { log.warn("1"); log.error("3"); }',
  };
  for (const [f, s] of Object.entries(content)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); }
  try {
    const r = await run({ root, changed: null });
    assert.deepEqual(r.findings.map(f => [f.rule, f.severity]), [['log-warn-deficit', 'info'], ['log-warn-deficit-plugin', 'info']]);
    assert.equal((await run({ root, changed: [] })).findings.length, 0);
  } finally { fs.rmSync(root, { recursive: true }); }
});
