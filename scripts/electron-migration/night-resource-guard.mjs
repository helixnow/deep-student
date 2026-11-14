// G3 uses this small wrapper in its systemd unit. Wait for admission, preserve
// the child's real terminal status, and never reuse an old latest report.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { admission, resources } from './lib/resource-budget.mjs';

const [receiptFile, bin, ...args] = process.argv.slice(2);
if (!receiptFile || !bin) throw new Error('usage: night-resource-guard.mjs RECEIPT COMMAND ...');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
if (dirty) throw new Error('G3 needs a clean frozen worktree');
fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
const receipt = { head, cwd: process.cwd(), bin, args, admittedAt: null, terminal: false };
const save = () => {
  fs.writeFileSync(`${receiptFile}.tmp`, JSON.stringify(receipt, null, 2));
  fs.renameSync(`${receiptFile}.tmp`, receiptFile);
};
save();
while (!admission(resources()).ok) await new Promise(resolve => setTimeout(resolve, 15000));
receipt.admittedAt = new Date().toISOString();
receipt.resources = resources();
save();
const child = spawn(bin, args, { stdio: 'inherit' });
receipt.pid = child.pid;
save();
child.on('error', error => {
  Object.assign(receipt, { terminal: true, error: error.message, endedAt: new Date().toISOString() });
  save(); process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  Object.assign(receipt, { terminal: true, code, signal, endedAt: new Date().toISOString(), headAfter: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() });
  save(); process.exitCode = code ?? 1;
});
process.on('SIGTERM', () => { child.kill('SIGTERM'); });
