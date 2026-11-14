// Recording provenance for synthetic G3 runs, written with the production writers: a
// RECORDING.json (g3-recording/v2) with host-receipt.json and an A build receipt, plus one
// admitted worker receipt per side listing that side's traces under the run directory.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { HOST_RECEIPT_FILE, RECORDING_FILE, aBuildEvidence, gitState, hostReceipt, recordingIdentity } from '../../../../scripts/electron-migration/record/g3-provenance.mjs';
import { writeWorkerReceipt } from '../../../../scripts/electron-migration/record/g3-worker.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function traceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !['compare', 'receipts'].includes(entry.name)) found.push(...traceFiles(path));
    else if (/^trace\.json(\.gz)?$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** Seal every trace below `runsDir` (side = its parent directory name: A, A2, A1 or B). */
export function sealRecording(root, runsDir) {
  const out = join(root, runsDir);
  const aReceipt = join(root, 'a-build.receipt.json');
  writeFileSync(aReceipt, JSON.stringify({ schema: 'wp043-tauri-build', job: 'fixture-build', code: 0, binarySha256: 'a'.repeat(64) }));
  const hostText = JSON.stringify(hostReceipt(root), null, 2) + '\n';
  writeFileSync(join(out, HOST_RECEIPT_FILE), hostText);
  const recording = recordingIdentity({ root, git: gitState(root), host: { sha256: sha(hostText) }, aBuild: aBuildEvidence(aReceipt),
    normalizerSha256: 'fixture', approvalsSha256: 'fixture', corpus: {}, isolation: 'fixture' });
  writeFileSync(join(out, RECORDING_FILE), JSON.stringify(recording, null, 2) + '\n');
  const recordingRef = { file: join(out, RECORDING_FILE), sha256: sha(readFileSync(join(out, RECORDING_FILE))) };
  const bySide = new Map();
  for (const file of traceFiles(out)) {
    const side = basename(dirname(file)) === 'B' ? 'B' : basename(dirname(file)) === 'A2' ? 'A2' : 'A';
    bySide.set(side, [...(bySide.get(side) ?? []), file]);
  }
  const clean = { schema: 'g3-process/v1', outcome: 'exited', ok: true, code: 0, signal: null, stdio: 'closed', escalation: [] };
  for (const [side, files] of bySide) {
    const summaryFile = join(out, 'summaries', side, 'summary.json');
    mkdirSync(dirname(summaryFile), { recursive: true });
    const runs = files.map(file => ({ id: relative(out, file), side, status: 'recorded', trace: file }));
    writeFileSync(summaryFile, JSON.stringify({ runs }));
    writeWorkerReceipt(out, { side, shard: { key: 'fixture/000', file: 'fixture.json', ids: runs.map(run => run.id) }, recording: recordingRef,
      result: clean, logFile: null, summaryFile, admitted: { runs } });
  }
  return { aReceipt, recordingFile: join(out, RECORDING_FILE), hostFile: join(out, HOST_RECEIPT_FILE) };
}
