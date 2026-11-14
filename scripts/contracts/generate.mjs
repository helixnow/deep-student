#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './generate.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const check = process.argv.includes('--check');
const { files, summary } = generate(root);
const generatedDir = join(root, 'contracts/ipc/generated');
const stale = existsSync(generatedDir) ? readdirSync(generatedDir)
  .filter(file => file.endsWith('.ts') && !files.has(`contracts/ipc/generated/${file}`)) : [];
if (stale.length) throw new Error(`Remove obsolete generated types: ${stale.join(', ')}`);
const changed = [];
for (const [file, text] of files) {
  const absolute = join(root, file);
  if (existsSync(absolute) && readFileSync(absolute, 'utf8') === text) continue;
  if (check) changed.push(file);
  else {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }
}
console.log(summary);
if (changed.length) {
  console.error(`IPC types/reports are stale; run npm run contracts:generate:\n${changed.join('\n')}`);
  process.exitCode = 1;
} else if (check) console.log('contracts:check OK');
