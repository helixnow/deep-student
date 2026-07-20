#!/usr/bin/env node
/**
 * Generates the machine-readable migration compatibility report.
 *
 * Consumed by the release pipeline (uploaded as the
 * `migration-compatibility-report` artifact) and by nightly runs. The report
 * records exactly what evidence backs a "migrations are compatible" claim:
 * candidate commit, tag, platform, fixture archive hash, executed test
 * counts, per-fixture-case results, and release-requirement (E2E) status.
 *
 * Usage:
 *   node scripts/migration-ci/generate-report.mjs \
 *     --out report.json \
 *     --candidate-commit SHA [--tag vX.Y.Z] [--platform linux-x86_64] \
 *     [--fixture-hash HASH] [--fixture-tier full] \
 *     [--test-count N | --test-count-file counts.json] \
 *     [--harness-report file.jsonl ...] \
 *     [--requirements-result file.json] \
 *     [--fail-on-empty]
 *
 * --fail-on-empty makes the tool exit non-zero when there is neither a test
 * count nor any harness case — preventing an "empty but green" report.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';

function parseArgs(argv) {
  const args = { harnessReports: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${key}`);
      return argv[i];
    };
    switch (key) {
      case '--out': args.out = next(); break;
      case '--candidate-commit': args.candidateCommit = next(); break;
      case '--tag': args.tag = next(); break;
      case '--platform': args.platform = next(); break;
      case '--fixture-hash': args.fixtureHash = next(); break;
      case '--fixture-tier': args.fixtureTier = next(); break;
      case '--test-count': args.testCount = Number(next()); break;
      case '--test-count-file': args.testCountFile = next(); break;
      case '--harness-report': args.harnessReports.push(next()); break;
      case '--requirements-result': args.requirementsResult = next(); break;
      case '--fail-on-empty': args.failOnEmpty = true; break;
      default: throw new Error(`unknown argument: ${key}`);
    }
  }
  if (!args.out) throw new Error('--out is required');
  if (!args.candidateCommit) throw new Error('--candidate-commit is required');
  return args;
}

function readJsonLines(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function buildReport(args) {
  let testCount = null;
  if (typeof args.testCount === 'number' && Number.isFinite(args.testCount)) {
    testCount = args.testCount;
  } else if (args.testCountFile) {
    const parsed = JSON.parse(readFileSync(args.testCountFile, 'utf8'));
    testCount = parsed.migration_test_count ?? null;
  }

  const fixtureCases = [];
  for (const file of args.harnessReports) {
    fixtureCases.push(...readJsonLines(file));
  }

  let requirements = null;
  if (args.requirementsResult) {
    requirements = JSON.parse(readFileSync(args.requirementsResult, 'utf8'));
  }

  const failedCases = fixtureCases.filter((c) => !c.ok);
  const report = {
    schema: 'deep-student/migration-compatibility-report@1',
    generated_at: new Date().toISOString(),
    candidate_commit: args.candidateCommit,
    tag: args.tag ?? null,
    platform: args.platform ?? `${process.platform}-${process.arch}`,
    runner: hostname(),
    fixture: {
      tier: args.fixtureTier ?? null,
      hash: args.fixtureHash ?? 'none',
      case_count: fixtureCases.length,
      failed_case_count: failedCases.length,
      cases: fixtureCases,
    },
    tests: {
      migration_test_count: testCount,
    },
    release_requirements: requirements,
    ok:
      failedCases.length === 0 &&
      (testCount === null || testCount > 0) &&
      (requirements === null || requirements.ok === true),
  };

  if (args.failOnEmpty && (testCount === null || testCount === 0) && fixtureCases.length === 0) {
    throw new Error(
      'report would contain no evidence (no test count, no fixture cases) — refusing to emit an empty-but-green report'
    );
  }
  return report;
}

const isMain =
  process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = buildReport(args);
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
    console.log(`✅ migration compatibility report written to ${args.out}`);
    console.log(
      `   commit=${report.candidate_commit} tag=${report.tag ?? '-'} platform=${report.platform}`
    );
    console.log(
      `   fixture: tier=${report.fixture.tier ?? '-'} hash=${report.fixture.hash} cases=${report.fixture.case_count} failed=${report.fixture.failed_case_count}`
    );
    console.log(`   migration_test_count=${report.tests.migration_test_count ?? '-'} ok=${report.ok}`);
    if (!report.ok) {
      console.error('::error::migration compatibility report is NOT ok');
      process.exit(1);
    }
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
