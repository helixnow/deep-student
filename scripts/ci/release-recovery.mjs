#!/usr/bin/env node
// Checkpoints are written only after a stage uploaded all of its outputs.
// Artifact storage (not the disposable compiler cache) is the recovery boundary.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAGES = {
  frontend: ['frontend-dist'],
  migration: ['migration-compatibility-report'],
  'macos-arm': ['macos-aarch64-apple-darwin', 'release-provenance-aarch64-apple-darwin'],
  'macos-intel': ['macos-x86_64-apple-darwin', 'release-provenance-x86_64-apple-darwin'],
  windows: ['windows-x86_64', 'release-provenance-x86_64-pc-windows-msvc'],
  linux: ['linux-x86_64', 'release-provenance-x86_64-unknown-linux-gnu'],
};
const trustedPaths = new Set(['.github/workflows/release.yml', '.github/workflows/rebuild-release.yml']);
export function checkpoint(stage, env = process.env) {
  assert.ok(STAGES[stage], `unknown stage: ${stage}`);
  const sourceSha = env.RELEASE_SOURCE_SHA;
  const workflowSha = env.RELEASE_WORKFLOW_SHA;
  for (const sha of [sourceSha, workflowSha]) assert.match(sha || '', /^[a-f0-9]{40}$/);
  return { schema: 1, stage, sourceSha, workflowSha, policy: env.RELEASE_POLICY || '',
    frontendSha256: stage === 'migration' ? null : env.RELEASE_FRONTEND_SHA || null,
    artifacts: STAGES[stage] };
}
export function reusableReceipt(receipt, expected, artifacts) {
  try { assert.deepEqual(receipt, expected); } catch { return false; }
  const available = new Set(artifacts.filter((a) => !a.expired).map((a) => a.name));
  return expected.artifacts.every((name) => available.has(name));
}
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000 });
}
function api(endpoint) { return JSON.parse(gh(['api', endpoint])); }
function download(repo, run, name, dir) {
  mkdirSync(dir, { recursive: true });
  gh(['run', 'download', String(run), '--repo', repo, '--name', name, '--dir', dir]);
}
function policy(stage) {
  if (stage === 'migration') return process.env.ALLOW_MISSING_FIXTURES || 'false';
  if (['macos-arm', 'macos-intel', 'windows'].includes(stage)) return process.env.ALLOW_UNSIGNED_DESKTOP || 'true';
  return '';
}
async function main() {
  const [command, stage, arg] = process.argv.slice(2);
  if (command === 'write') {
    if (stage !== 'migration' && !process.env.RELEASE_FRONTEND_SHA) {
      process.env.RELEASE_FRONTEND_SHA = JSON.parse(readFileSync('dist/.deepstudent-release.json', 'utf8')).distSha256;
    }
    if (stage !== 'migration') assert.match(process.env.RELEASE_FRONTEND_SHA || '', /^[a-f0-9]{64}$/);
    mkdirSync(path.dirname(arg), { recursive: true });
    writeFileSync(arg, JSON.stringify(checkpoint(stage), null, 2) + '\n');
    return;
  }
  const repo = process.env.GITHUB_REPOSITORY;
  assert.match(repo || '', /^[\w.-]+\/[\w.-]+$/);
  const temp = mkdtempSync(path.join(os.tmpdir(), 'release-recovery-'));
  try {
    if (command === 'plan') {
      const requested = process.env.RESUME_RUN_ID || '';
      assert.match(requested, /^\d*$/);
      if (process.env.FORCE_REBUILD === 'true') {
        assert.equal(requested, '', 'force_rebuild and resume_run_id cannot be combined');
        for (const name of Object.keys(STAGES)) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=\n`);
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## Release recovery\nExplicit full rebuild requested.\n');
        return;
      }
      const runs = requested ? [api(`repos/${repo}/actions/runs/${requested}`)] :
        ['release.yml', 'rebuild-release.yml'].flatMap((workflow) => api(`repos/${repo}/actions/workflows/${workflow}/runs?per_page=30`).workflow_runs)
          .sort((a, b) => b.id - a.id);
      const selected = {};
      let frontendSha;
      for (const run of runs) {
        if (!trustedPaths.has(run.path) || !['push', 'workflow_dispatch', 'workflow_run'].includes(run.event)) continue;
        if (String(run.id) === process.env.GITHUB_RUN_ID || run.status !== 'completed') continue;
        // All supported callers run tooling from their head revision. Receipts
        // below also bind source independently (rebuild source != workflow HEAD).
        if (run.head_sha !== process.env.RELEASE_WORKFLOW_SHA) continue;
        const artifacts = api(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`).artifacts;
        for (const name of Object.keys(STAGES)) {
          if (selected[name] || !artifacts.some((a) => a.name === `release-complete-${name}` && !a.expired)) continue;
          const dir = path.join(temp, String(run.id), name);
          download(repo, run.id, `release-complete-${name}`, dir);
          const receipt = JSON.parse(readFileSync(path.join(dir, 'checkpoint.json'), 'utf8'));
          if (name !== 'migration' && !/^[a-f0-9]{64}$/.test(receipt.frontendSha256 || '')) continue;
          if (name !== 'migration' && name !== 'frontend' && !frontendSha) continue;
          const expected = checkpoint(name, { ...process.env, RELEASE_POLICY: policy(name),
            RELEASE_FRONTEND_SHA: name === 'frontend' ? receipt.frontendSha256 : frontendSha });
          if (reusableReceipt(receipt, expected, artifacts)) {
            selected[name] = String(run.id);
            if (name === 'frontend') frontendSha = receipt.frontendSha256;
          }
        }
        if (Object.keys(selected).length === Object.keys(STAGES).length) break;
      }
      assert.ok(!requested || Object.keys(selected).length > 0,
        'Requested run has no reusable checkpoints for this source/tooling/policy (or its artifacts expired); refusing an accidental full rebuild');
      for (const name of Object.keys(STAGES)) {
        appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${selected[name] || ''}\n`);
        console.log(`${name}: ${selected[name] ? `reuse run ${selected[name]}` : 'build'} `);
      }
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Release recovery\nSource: ${process.env.RELEASE_SOURCE_SHA}\n\n` +
        Object.keys(STAGES).map((name) => `- ${name}: ${selected[name] ? `reuse #${selected[name]}` : 'build'}`).join('\n') + '\n');
    } else if (command === 'restore') {
      assert.match(arg || '', /^\d+$/);
      const run = api(`repos/${repo}/actions/runs/${arg}`);
      assert.ok(trustedPaths.has(run.path) && ['push', 'workflow_dispatch', 'workflow_run'].includes(run.event), 'untrusted recovery run');
      assert.equal(run.head_sha, process.env.RELEASE_WORKFLOW_SHA, 'recovery tooling revision changed');
      const dir = path.join('recovered', stage);
      download(repo, arg, `release-complete-${stage}`, path.join(dir, 'receipt'));
      const receipt = JSON.parse(readFileSync(path.join(dir, 'receipt/checkpoint.json'), 'utf8'));
      if (stage !== 'migration') assert.match(receipt.frontendSha256 || '', /^[a-f0-9]{64}$/);
      const expected = checkpoint(stage, { ...process.env, RELEASE_FRONTEND_SHA: receipt.frontendSha256 });
      const artifacts = api(`repos/${repo}/actions/runs/${arg}/artifacts?per_page=100`).artifacts;
      assert.ok(reusableReceipt(receipt, expected, artifacts), 'checkpoint mismatch or expired assets');
      for (const name of expected.artifacts) download(repo, arg, name, path.join(dir, name));
    } else throw Error(`unknown command ${command}`);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
