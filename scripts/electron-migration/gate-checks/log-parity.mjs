// Rust warn!/error! vs TS logger warn/error, report-only (X6 task: 先只报告不拦截).
//
// Correspondence, in order of strength:
//   1. file: TS production files of the owning plugin that cite the Rust file name
//      (header/inline comments like `chatanki_executor.rs:1873`), summed per Rust file;
//   2. plugin: all owned non-test Rust vs all TS production in the plugin.
// A TS file citing several Rust files is counted for each of them; this can hide a
// deficit (miss) but never invents one. Deficits are candidates, not proven omissions.
import fs from 'node:fs';
import path from 'node:path';
import { cli, files, location, pluginOf, production, read, report, selected, source, ts, walk } from './common.mjs';
import { rustEvidence } from './rust-evidence.mjs';

const LEVELS = ['warn', 'error'];
export function tsLogs(file, text) {
  const sf = source(file, text), out = [];
  walk(sf, n => {
    if (!ts.isCallExpression(n)) return;
    const e = n.expression;
    let level = null;
    if (ts.isPropertyAccessExpression(e) && LEVELS.includes(e.name.text) && !/^console$/.test(e.expression.getText()) && /log/i.test(e.expression.getText())) level = e.name.text;
    else if (ts.isIdentifier(e) && /^log(Warn|Error)$/.test(e.text)) level = e.text.slice(3).toLowerCase();
    if (level) out.push({ ...location(n), level });
  });
  return out;
}
export function rustLogs(functions) {
  const counts = { warn: 0, error: 0 };
  for (const f of functions) if (!f.testOnly) for (const l of LEVELS) counts[l] += f.macros[l] ?? 0;
  return counts;
}
export async function run(opts) {
  const findings = [], details = [];
  for (const lane of files(opts.root, 'host/plugins').filter(f => f.endsWith('/LANE.md'))) {
    const plugin = pluginOf(lane);
    const rustFiles = [...new Set([...read(opts.root, lane).matchAll(/`(src-tauri\/[^`]+\.rs)`/g)].map(m => m[1]))].filter(f => fs.existsSync(path.join(opts.root, f)));
    if (!rustFiles.length) continue;
    const tsFiles = files(opts.root, `host/plugins/${plugin}`).filter(production);
    if (opts.changed !== null && ![lane, ...tsFiles, ...rustFiles].some(f => selected(opts, f))) continue;
    const tsText = new Map(tsFiles.map(f => [f, read(opts.root, f)]));
    const tsCount = new Map(tsFiles.map(f => [f, tsLogs(f, tsText.get(f))]));
    const sum = list => ({ warn: list.filter(x => x.level === 'warn').length, error: list.filter(x => x.level === 'error').length });
    const pluginRust = { warn: 0, error: 0 };
    for (const rf of rustFiles) {
      const rust = rustLogs(await rustEvidence(read(opts.root, rf)));
      pluginRust.warn += rust.warn; pluginRust.error += rust.error;
      if (!rust.warn && !rust.error) continue;
      const base = path.basename(rf);
      const mapped = tsFiles.filter(f => tsText.get(f).includes(base));
      const tsc = sum(mapped.flatMap(f => tsCount.get(f)));
      const detail = { plugin, rust: rf, rustWarn: rust.warn, rustError: rust.error, mapping: mapped.length ? 'file' : 'none', tsFiles: mapped, tsWarn: tsc.warn, tsError: tsc.error };
      details.push(detail);
      if (mapped.length) for (const l of LEVELS) if (rust[l] > tsc[l]) {
        findings.push({ file: mapped[0], line: 1, plugin, severity: 'info', rule: `log-${l}-deficit`, rust: rf, message: `${base}: Rust ${l}! ${rust[l]} > TS ${l} ${tsc[l]} across ${mapped.length} citing file(s)` });
      }
    }
    const pluginTs = sum([...tsCount.values()].flat());
    details.push({ plugin, rust: '(all owned)', rustWarn: pluginRust.warn, rustError: pluginRust.error, mapping: 'plugin', tsWarn: pluginTs.warn, tsError: pluginTs.error });
    for (const l of LEVELS) if (pluginRust[l] > pluginTs[l]) {
      findings.push({ file: lane, line: 1, plugin, severity: 'info', rule: `log-${l}-deficit-plugin`, message: `plugin total: Rust ${l}! ${pluginRust[l]} > TS ${l} ${pluginTs[l]}` });
    }
  }
  return report('log-parity', findings, { details, policy: 'Report-only. Counts static call sites (non-test Rust fns via tree-sitter; TS logger .warn/.error or logWarn/logError). No function-level SPEC mapping is parsed yet; file mapping is by Rust file name cited in TS source. Unmapped Rust files appear only in details/plugin totals.' });
}
await cli(import.meta.url, run, { blocking: false });
