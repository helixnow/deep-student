import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ANDROID_VERSION_CODE,
  ANDROID_VERSION_BASE_APP_VERSION,
  BUILD_NUMBER_BASE,
  BUILD_NUMBER_BASE_COMMIT,
  PUBLISHED_ANDROID_VERSION_CODE,
  buildNumberFromCommitCount,
  formatSentryRelease,
  generateVersionFiles,
  resolveAndroidVersionCode,
  resolveBuildNumber,
  resolveGitRevision,
  validateBuildConfiguration,
} from '../generate-version.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testDir, '..', '..');

function writeBuildConfigFixture(
  root,
  {
    packageVersion = ANDROID_VERSION_BASE_APP_VERSION,
    tauriVersion = packageVersion,
  } = {},
) {
  mkdirSync(join(root, 'resources/app'), { recursive: true });
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ version: packageVersion })}\n`);
  writeFileSync(
    join(root, 'resources/app', 'tauri.conf.json'),
    JSON.stringify({
      version: tauriVersion,
      bundle: { android: { versionCode: ANDROID_VERSION_CODE } },
    }),
  );
}

test('Android release code is one above nightly and build numbers remain monotonic', () => {
  // 基线是固定锚点（不得由 release-please 自动推进），"下一版本"断言直接
  // 从锚点派生：应用版本 bump 而锚点不动时，versionCode 必须严格递增。
  const [baseMajor, baseMinor, basePatch] = ANDROID_VERSION_BASE_APP_VERSION.split('.')
    .map(Number);
  const nextPatchVersion = `${baseMajor}.${baseMinor}.${basePatch + 1}`;
  assert.equal(ANDROID_VERSION_CODE, PUBLISHED_ANDROID_VERSION_CODE + 1);
  assert.equal(resolveAndroidVersionCode(ANDROID_VERSION_BASE_APP_VERSION), ANDROID_VERSION_CODE);
  assert.equal(resolveAndroidVersionCode(nextPatchVersion), ANDROID_VERSION_CODE + 1);
  assert.ok(resolveAndroidVersionCode('0.10.0') > ANDROID_VERSION_CODE + 1);
  assert.throws(() => resolveAndroidVersionCode('0.9.41'), /predates Android baseline/);
  for (const nonStableVersion of [
    '0.9.43-alpha',
    '0.9.43+build2',
    '0.9.43-',
    '00.9.43',
    '0.09.43',
    '0.9.043',
  ]) {
    assert.throws(
      () => resolveAndroidVersionCode(nonStableVersion),
      /stable major\.minor\.patch semantic version/,
    );
  }
  assert.equal(buildNumberFromCommitCount(0), BUILD_NUMBER_BASE);
  assert.equal(buildNumberFromCommitCount(1), BUILD_NUMBER_BASE + 1);
  assert.equal(buildNumberFromCommitCount(28), BUILD_NUMBER_BASE + 28);
  assert.throws(() => buildNumberFromCommitCount(-1), /non-negative integer/);
});

test('build number uses only HEAD ancestry after the fixed baseline', () => {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === 'rev-list') return '28';
    return '';
  };

  assert.equal(resolveBuildNumber({ env: {}, git }), BUILD_NUMBER_BASE + 28);
  assert.deepEqual(calls, [
    ['cat-file', '-e', `${BUILD_NUMBER_BASE_COMMIT}^{commit}`],
    ['merge-base', '--is-ancestor', BUILD_NUMBER_BASE_COMMIT, 'HEAD'],
    ['rev-list', '--count', `${BUILD_NUMBER_BASE_COMMIT}..HEAD`],
  ]);
});

test('explicit build number override remains validated against the published baseline', () => {
  assert.equal(
    resolveBuildNumber({
      env: { DEEP_STUDENT_BUILD_NUMBER: String(BUILD_NUMBER_BASE + 50) },
      git: () => assert.fail('git must not run for an explicit build number'),
    }),
    BUILD_NUMBER_BASE + 50,
  );
  assert.equal(
    resolveBuildNumber({
      env: { DEEP_STUDENT_BUILD_NUMBER: String(ANDROID_VERSION_CODE) },
    }),
    ANDROID_VERSION_CODE,
  );
  assert.throws(
    () =>
      resolveBuildNumber({
        env: { DEEP_STUDENT_BUILD_NUMBER: String(BUILD_NUMBER_BASE) },
      }),
    /must be greater than/,
  );
  for (const malformed of ['', ' 14634', '+14634', '1.4634e4']) {
    assert.throws(
      () => resolveBuildNumber({ env: { DEEP_STUDENT_BUILD_NUMBER: malformed } }),
      /decimal digits only/,
    );
  }
});

test('Node repository config keeps a non-regressing fallback code', () => {
  const { androidVersionCode, appVersion } = validateBuildConfiguration(projectRoot);
  assert.equal(androidVersionCode, ANDROID_VERSION_CODE);
  // 应用版本可以领先锚点（release-please 只 bump 应用版本），但不得落后于锚点，
  // 且解析出的 versionCode 不得小于锚点码——跨发布单调性的仓库级契约。
  assert.ok(
    resolveAndroidVersionCode(appVersion) >= ANDROID_VERSION_CODE,
    `appVersion ${appVersion} must not resolve below the anchor code`,
  );

});

test('Android baseline is a fixed anchor that release-please must not auto-advance', () => {
  // F1 防回归（2026-09-07 审阅）：基准行挂 x-release-please-version 时，
  // release-please 会把基准与应用版本同步推进，差值恒为 0，versionCode 跨
  // 发布停滞甚至回退（0.9.54 tag 为 14640，0.9.55 线曾回落 14639）。
  const generatorSource = readFileSync(
    join(projectRoot, 'scripts', 'generate-version.mjs'),
    'utf-8',
  );
  const baselineLine = generatorSource
    .split('\n')
    .find((line) => line.includes('ANDROID_VERSION_BASE_APP_VERSION ='));
  assert.ok(baselineLine, 'baseline constant must exist');
  assert.doesNotMatch(baselineLine, /x-release-please-version/u);

  const releasePleaseConfig = JSON.parse(
    readFileSync(join(projectRoot, 'release-please-config.json'), 'utf-8'),
  );
  const extraFiles = releasePleaseConfig.packages['.']['extra-files'].map((f) => f.path);
  assert.ok(
    !extraFiles.includes('scripts/generate-version.mjs'),
    'release-please must not rewrite the version generator',
  );

  // 跨发布单调性：模拟「应用版本已 bump、锚点不动」的下一发布态。
  const [major, minor, patch] = ANDROID_VERSION_BASE_APP_VERSION.split('.').map(Number);
  const simulatedNextRelease = `${major}.${minor}.${patch + 1}`;
  assert.ok(
    resolveAndroidVersionCode(simulatedNextRelease) > resolveAndroidVersionCode(ANDROID_VERSION_BASE_APP_VERSION),
    'a release on top of a frozen anchor must yield a strictly greater versionCode',
  );
  // 锚点码必须高于任何「可能已发布」的历史码。
  assert.ok(ANDROID_VERSION_CODE > PUBLISHED_ANDROID_VERSION_CODE);
});

test('Node package and application config versions must stay aligned without a Cargo tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'deep-student-version-contract-'));
  try {
    writeBuildConfigFixture(root);
    assert.equal(validateBuildConfiguration(root).appVersion, ANDROID_VERSION_BASE_APP_VERSION);

    writeBuildConfigFixture(root, { tauriVersion: '0.9.47' });
    assert.throws(() => validateBuildConfiguration(root), /Application versions must match/);

    writeBuildConfigFixture(root, {
      packageVersion: '0.9.47',
      tauriVersion: ANDROID_VERSION_BASE_APP_VERSION,
    });
    assert.throws(() => validateBuildConfiguration(root), /Application versions must match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Node generated metadata keeps Android release code separate from internal build number', () => {
  const root = mkdtempSync(join(tmpdir(), 'deep-student-version-'));
  const previousOverride = process.env.DEEP_STUDENT_BUILD_NUMBER;
  const originalLog = console.log;
  const originalWarn = console.warn;
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeBuildConfigFixture(root);

    process.env.DEEP_STUDENT_BUILD_NUMBER = String(ANDROID_VERSION_CODE + 27);
    console.log = () => {};
    console.warn = () => {};
    const generated = generateVersionFiles(root);
    assert.equal(generated.buildNumber, String(ANDROID_VERSION_CODE + 27));
    assert.equal(generated.androidVersionCode, ANDROID_VERSION_CODE);

    const version = readFileSync(join(root, 'src', 'version.ts'), 'utf-8');
    assert.ok(version.includes(`BUILD_NUMBER: '${ANDROID_VERSION_CODE + 27}'`));
    assert.ok(version.includes(`APP_VERSION: '${ANDROID_VERSION_BASE_APP_VERSION}'`));
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    if (previousOverride === undefined) {
      delete process.env.DEEP_STUDENT_BUILD_NUMBER;
    } else {
      process.env.DEEP_STUDENT_BUILD_NUMBER = previousOverride;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('Sentry releases disambiguate sibling commits with the same numeric build', () => {
  const buildNumber = buildNumberFromCommitCount(1);
  const siblingA = formatSentryRelease('0.9.42', buildNumber, 'a'.repeat(40));
  const siblingB = formatSentryRelease('0.9.42', buildNumber, 'b'.repeat(40));
  assert.notEqual(siblingA, siblingB);
  assert.equal(
    siblingA,
    formatSentryRelease('0.9.42', buildNumber, 'a'.repeat(40)),
    'rebuilding the same commit must keep the same release',
  );
});

test('the Sentry release CLI uses the canonical version, build number and revision', () => {
  const buildNumber = BUILD_NUMBER_BASE + 50;
  const release = execFileSync(
    process.execPath,
    [join(projectRoot, 'scripts', 'generate-version.mjs'), '--print-sentry-release'],
    { cwd: projectRoot, encoding: 'utf-8', env: { ...process.env, DEEP_STUDENT_BUILD_NUMBER: String(buildNumber) } },
  ).trim();
  const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
  assert.equal(
    release,
    formatSentryRelease(
      packageJson.version,
      buildNumber,
      resolveGitRevision({ root: projectRoot }),
    ),
  );


});
