// Self-tests for the migration CI tooling. Run with:
//   node --test scripts/migration-ci/__tests__/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const toolsDir = fileURLToPath(new URL('..', import.meta.url));
const { evaluate } = await import(new URL('../verify-release-requirements.mjs', import.meta.url));
const { buildReport } = await import(new URL('../generate-report.mjs', import.meta.url));

const baseManifest = () => ({
  schema: 'deep-student/release-requirements@1',
  requirements: [
    {
      id: 'upgrade-e2e-linux',
      platform: 'linux',
      kind: 'artifact-upgrade-e2e',
      driver: { type: 'script', entry: 'scripts/migration-ci/e2e/upgrade-linux.sh' },
      waiver: { until: '2026-08-31', reason: 'no driver yet', approved_by: 'rel-eng' },
    },
  ],
});

test('requirement with valid waiver is waived, not passed', () => {
  const outcome = evaluate(baseManifest(), {
    now: new Date('2026-08-01T00:00:00Z'),
    repoRoot: mkdtempSync(join(tmpdir(), 'norepo-')),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.requirements[0].status, 'waived');
  assert.equal(outcome.waived_count, 1);
});

test('expired waiver fails the gate (fail-closed)', () => {
  const outcome = evaluate(baseManifest(), {
    now: new Date('2026-09-01T00:00:00Z'),
    repoRoot: mkdtempSync(join(tmpdir(), 'norepo-')),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.requirements[0].status, 'failed');
});

test('missing waiver and missing driver fails the gate', () => {
  const manifest = baseManifest();
  delete manifest.requirements[0].waiver;
  const outcome = evaluate(manifest, {
    now: new Date('2026-08-01T00:00:00Z'),
    repoRoot: mkdtempSync(join(tmpdir(), 'norepo-')),
  });
  assert.equal(outcome.ok, false);
});

test('runnable driver that was not executed fails the gate', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-'));
  mkdirSync(join(repoRoot, 'scripts/migration-ci/e2e'), { recursive: true });
  writeFileSync(join(repoRoot, 'scripts/migration-ci/e2e/upgrade-linux.sh'), '#!/bin/sh\n');
  const outcome = evaluate(baseManifest(), { now: new Date('2026-08-01T00:00:00Z'), repoRoot });
  assert.equal(outcome.ok, false);
  assert.match(outcome.requirements[0].detail, /was not executed/);
});

test('runnable driver with passing result passes', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-'));
  mkdirSync(join(repoRoot, 'scripts/migration-ci/e2e'), { recursive: true });
  writeFileSync(join(repoRoot, 'scripts/migration-ci/e2e/upgrade-linux.sh'), '#!/bin/sh\n');
  const outcome = evaluate(baseManifest(), {
    now: new Date('2026-08-01T00:00:00Z'),
    repoRoot,
    results: { 'upgrade-e2e-linux': { executed: true, passed: true } },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.requirements[0].status, 'passed');
});

test('empty manifest is rejected (no vacuous pass)', () => {
  assert.throws(() =>
    evaluate({ schema: 'deep-student/release-requirements@1', requirements: [] }, {})
  );
});

test('committed release-requirements.json is schema-valid and evaluates', () => {
  const manifest = JSON.parse(readFileSync(join(toolsDir, 'release-requirements.json'), 'utf8'));
  const outcome = evaluate(manifest, { now: new Date('2026-07-19T00:00:00Z'), repoRoot: join(toolsDir, '../..') });
  assert.equal(outcome.requirements.length, 4);
  const platforms = outcome.requirements.map((r) => r.platform).sort();
  assert.deepEqual(platforms, ['android', 'linux', 'macos', 'windows']);
});

test('buildReport merges counts, harness cases and requirement results', () => {
  const dir = mkdtempSync(join(tmpdir(), 'report-'));
  const harness = join(dir, 'cases.jsonl');
  writeFileSync(
    harness,
    '{"case":"v0.9.20-basic","mode":"upgrade","ok":true,"elapsed_ms":1200,"detail":"upgraded 4 databases"}\n' +
      '{"case":"v0.9.28-heavy","mode":"upgrade","ok":true,"elapsed_ms":3400,"detail":"upgraded 4 databases"}\n'
  );
  const countFile = join(dir, 'counts.json');
  writeFileSync(countFile, JSON.stringify({ migration_test_count: 57 }));

  const report = buildReport({
    out: join(dir, 'report.json'),
    candidateCommit: 'abc123',
    tag: 'v1.0.0',
    platform: 'linux-x86_64',
    fixtureHash: 'deadbeef',
    fixtureTier: 'full',
    testCountFile: countFile,
    harnessReports: [harness],
  });
  assert.equal(report.ok, true);
  assert.equal(report.tests.migration_test_count, 57);
  assert.equal(report.fixture.case_count, 2);
  assert.equal(report.fixture.hash, 'deadbeef');
  assert.equal(report.candidate_commit, 'abc123');
});

test('buildReport flags failed fixture cases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'report-'));
  const harness = join(dir, 'cases.jsonl');
  writeFileSync(harness, '{"case":"bad","mode":"upgrade","ok":false,"elapsed_ms":10,"detail":"boom"}\n');
  const report = buildReport({
    out: join(dir, 'report.json'),
    candidateCommit: 'abc123',
    harnessReports: [harness],
    testCount: 57,
  });
  assert.equal(report.ok, false);
  assert.equal(report.fixture.failed_case_count, 1);
});

test('buildReport --fail-on-empty rejects evidence-free reports', () => {
  assert.throws(() =>
    buildReport({ out: '/dev/null', candidateCommit: 'abc', harnessReports: [], failOnEmpty: true })
  );
});

test('CLI: generate-report exits non-zero when report not ok', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const harness = join(dir, 'cases.jsonl');
  writeFileSync(harness, '{"case":"bad","mode":"fault","ok":false,"elapsed_ms":10,"detail":"boom"}\n');
  const res = spawnSync(process.execPath, [
    join(toolsDir, 'generate-report.mjs'),
    '--out', join(dir, 'report.json'),
    '--candidate-commit', 'abc',
    '--harness-report', harness,
    '--test-count', '57',
  ]);
  assert.notEqual(res.status, 0);
});

test('fetch-fixtures.sh skip mode emits fixtures_available=false without secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fx-'));
  const out = execFileSync(
    'bash',
    [join(toolsDir, 'fetch-fixtures.sh'), '--tier', 'representative', '--dest', dir, '--mode', 'skip'],
    { env: { ...process.env, MIGRATION_FIXTURE_URL: '', GITHUB_OUTPUT: '' }, encoding: 'utf8' }
  );
  assert.match(out, /fixtures_available=false/);
});

test('fetch-fixtures.sh require mode fails closed without secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fx-'));
  const res = spawnSync(
    'bash',
    [join(toolsDir, 'fetch-fixtures.sh'), '--tier', 'full', '--dest', dir, '--mode', 'require'],
    { env: { ...process.env, MIGRATION_FIXTURE_URL: '', GITHUB_OUTPUT: '' }, encoding: 'utf8' }
  );
  assert.notEqual(res.status, 0);
  assert.match(String(res.stderr), /fail-closed/);
});
