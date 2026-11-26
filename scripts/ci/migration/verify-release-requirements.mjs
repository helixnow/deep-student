#!/usr/bin/env node
/**
 * Release requirement manifest gate (honest, fail-closed E2E gating).
 *
 * The repository currently has no driver capable of running real-artifact
 * upgrade E2E on macOS/Windows/Linux/Android. Instead of a placeholder job
 * that is always green, this gate evaluates release-requirements.json:
 *
 *   - Requirement has a runnable driver (its `driver.entry` script exists):
 *     the release MUST provide an execution result for it via --results;
 *     a runnable-but-not-executed or failed requirement fails the gate.
 *   - Requirement has no runnable driver: it needs a valid (unexpired)
 *     waiver, which is loudly reported. An expired or missing waiver fails
 *     the gate — capability gaps cannot rot silently.
 *
 * Usage:
 *   node scripts/migration-ci/verify-release-requirements.mjs \
 *     [--manifest scripts/migration-ci/release-requirements.json] \
 *     [--results results.json] [--out requirements-result.json] [--now ISO]
 *
 * --results format: {"<requirement id>": {"executed": true, "passed": true}}
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${key}`);
      return argv[i];
    };
    switch (key) {
      case '--manifest': args.manifest = next(); break;
      case '--results': args.results = next(); break;
      case '--out': args.out = next(); break;
      case '--now': args.now = next(); break;
      case '--repo-root': args.repoRoot = next(); break;
      default: throw new Error(`unknown argument: ${key}`);
    }
  }
  return args;
}

export function evaluate(manifest, { results = {}, now = new Date(), repoRoot = '.' } = {}) {
  if (manifest.schema !== 'deep-student/release-requirements@1') {
    throw new Error(`unsupported manifest schema: ${manifest.schema}`);
  }
  if (!Array.isArray(manifest.requirements) || manifest.requirements.length === 0) {
    throw new Error('manifest has no requirements — refusing a vacuous pass');
  }

  const evaluated = manifest.requirements.map((req) => {
    for (const field of ['id', 'platform', 'kind', 'driver']) {
      if (!req[field]) throw new Error(`requirement missing required field '${field}'`);
    }
    const entryPath = req.driver.entry ? resolve(repoRoot, req.driver.entry) : null;
    const runnable = Boolean(entryPath && existsSync(entryPath));
    const result = results[req.id];

    let status;
    let detail;
    if (runnable) {
      if (result?.executed && result?.passed) {
        status = 'passed';
        detail = `driver ${req.driver.entry} executed and passed`;
      } else if (result?.executed) {
        status = 'failed';
        detail = `driver ${req.driver.entry} executed but did not pass`;
      } else {
        status = 'failed';
        detail = `driver ${req.driver.entry} exists but was not executed for this release`;
      }
    } else if (req.waiver?.until) {
      const until = new Date(`${req.waiver.until}T23:59:59Z`);
      if (Number.isNaN(until.getTime())) {
        status = 'failed';
        detail = `waiver 'until' date is invalid: ${req.waiver.until}`;
      } else if (now <= until) {
        status = 'waived';
        detail = `no driver capability; waived until ${req.waiver.until} (${req.waiver.reason ?? 'no reason given'})`;
      } else {
        status = 'failed';
        detail = `waiver expired on ${req.waiver.until} and no driver capability exists — release is blocked until a driver lands or the waiver is renewed in review`;
      }
    } else {
      status = 'failed';
      detail = 'no driver capability and no waiver — release is blocked';
    }

    return { id: req.id, platform: req.platform, kind: req.kind, status, detail };
  });

  return {
    schema: 'deep-student/release-requirements-result@1',
    evaluated_at: now.toISOString(),
    ok: evaluated.every((r) => r.status === 'passed' || r.status === 'waived'),
    waived_count: evaluated.filter((r) => r.status === 'waived').length,
    requirements: evaluated,
  };
}

const isMain =
  process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const manifestPath =
      args.manifest ?? new URL('./release-requirements.json', import.meta.url).pathname;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const results = args.results ? JSON.parse(readFileSync(args.results, 'utf8')) : {};
    const now = args.now ? new Date(args.now) : new Date();
    const repoRoot = args.repoRoot ?? resolve(dirname(manifestPath), '../..');

    const outcome = evaluate(manifest, { results, now, repoRoot });

    for (const r of outcome.requirements) {
      const icon = r.status === 'passed' ? '✅' : r.status === 'waived' ? '⚠️ ' : '❌';
      const line = `${icon} [${r.platform}] ${r.id}: ${r.status} — ${r.detail}`;
      console.log(line);
      if (r.status === 'waived') console.log(`::warning::release requirement waived: ${r.id} — ${r.detail}`);
      if (r.status === 'failed') console.error(`::error::release requirement failed: ${r.id} — ${r.detail}`);
    }

    if (args.out) {
      mkdirSync(dirname(args.out), { recursive: true });
      writeFileSync(args.out, JSON.stringify(outcome, null, 2) + '\n');
      console.log(`requirements result written to ${args.out}`);
    }
    if (!outcome.ok) process.exit(1);
    console.log(`✅ release requirements gate passed (${outcome.waived_count} waived)`);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
