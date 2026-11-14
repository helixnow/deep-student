/**
 * Debug CLI for a finished smoke run: list the renderer's IPC calls from `<root>/wire.jsonl` with their
 * phase, outcome and (truncated) result body, using the same invoke/result pairing as the specs.
 *
 *   node host/e2e/smoke/__tests__/support/wire-calls.ts <root> [cmd-regex] [--errors] [--width=N]
 *
 * `<root>` is the run's data root (`$TMPDIR/ds-w12-smoke/<label>-*`); `--errors` keeps failed and pending calls.
 */
import { callsFromWire, readWire } from './app.ts';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [root, pattern] = args.filter((a) => !a.startsWith('--'));
if (root === undefined) {
  console.error('usage: node host/e2e/smoke/__tests__/support/wire-calls.ts <root> [cmd-regex] [--errors] [--width=N]');
  process.exit(2);
}
const width = Number([...flags].find((f) => f.startsWith('--width='))?.slice('--width='.length) ?? 300);
const match = new RegExp(pattern ?? '.');
for (const call of callsFromWire(readWire(root))) {
  if (!match.test(call.cmd)) continue;
  if (flags.has('--errors') && call.outcome === 'result') continue;
  console.log(`${call.phase}\t${call.cmd}\t${call.outcome}\t${JSON.stringify(call.body ?? null).slice(0, width)}`);
}
