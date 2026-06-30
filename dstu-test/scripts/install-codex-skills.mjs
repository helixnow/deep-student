#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const sourceRoot = path.join(repoRoot, 'dstu-test', 'skills');
const codexHome = process.env.CODEX_HOME
  ? path.resolve(process.env.CODEX_HOME)
  : path.join(os.homedir(), '.codex');
const targetRoot = path.join(codexHome, 'skills');

const flags = new Set(process.argv.slice(2));
const dryRun = flags.has('--dry-run');
const force = flags.has('--force');

async function listSkills() {
  const entries = await fsp.readdir(sourceRoot, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

async function installSkill(name) {
  const source = path.join(sourceRoot, name);
  const target = path.join(targetRoot, name);
  const exists = fs.existsSync(target);

  if (exists && !force) {
    return { name, status: 'skipped', reason: 'already exists; pass --force to overwrite' };
  }

  if (dryRun) {
    return { name, status: exists ? 'would-overwrite' : 'would-install', target };
  }

  await fsp.mkdir(targetRoot, { recursive: true });
  if (exists) await fsp.rm(target, { recursive: true, force: true });
  await fsp.cp(source, target, { recursive: true });
  return { name, status: exists ? 'overwritten' : 'installed', target };
}

async function main() {
  const skills = await listSkills();
  const results = [];
  for (const skill of skills) {
    results.push(await installSkill(skill));
  }
  console.log(JSON.stringify({
    sourceRoot,
    targetRoot,
    dryRun,
    force,
    results,
  }, null, 2));
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
