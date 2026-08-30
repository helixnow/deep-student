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
    cargoVersion = packageVersion,
    tauriVersion = packageVersion,
  } = {},
) {
  mkdirSync(join(root, 'src-tauri', '.cargo'), { recursive: true });
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ version: packageVersion })}\n`);
  writeFileSync(
    join(root, 'src-tauri', 'Cargo.toml'),
    `[package]\nname = "fixture"\nversion = "${cargoVersion}"\n`,
  );
  writeFileSync(join(root, 'src-tauri', '.cargo', 'config.toml'), '[build]\n');
  writeFileSync(
    join(root, 'src-tauri', 'tauri.conf.json'),
    JSON.stringify({
      version: tauriVersion,
      bundle: { android: { versionCode: ANDROID_VERSION_CODE } },
    }),
  );
}

test('Android release code is one above nightly and build numbers remain monotonic', () => {
  assert.equal(ANDROID_VERSION_CODE, PUBLISHED_ANDROID_VERSION_CODE + 1);
  assert.equal(resolveAndroidVersionCode(ANDROID_VERSION_BASE_APP_VERSION), ANDROID_VERSION_CODE);
  assert.equal(resolveAndroidVersionCode('0.9.46'), ANDROID_VERSION_CODE + 1);
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

test('repository config has no pinned proxy and keeps a non-regressing fallback code', () => {
  const { androidVersionCode, appVersion } = validateBuildConfiguration(projectRoot);
  assert.equal(androidVersionCode, ANDROID_VERSION_CODE);
  assert.equal(appVersion, ANDROID_VERSION_BASE_APP_VERSION);

  const cargoConfig = readFileSync(
    join(projectRoot, 'src-tauri', '.cargo', 'config.toml'),
    'utf-8',
  );
  assert.doesNotMatch(cargoConfig, /^\s*proxy\s*=/mu);
  assert.doesNotMatch(cargoConfig, /^\s*\[target\.[^\]]+-linux-android\]\s*$/mu);
});

test('package, Cargo, and Tauri versions must stay aligned', () => {
  const root = mkdtempSync(join(tmpdir(), 'deep-student-version-contract-'));
  try {
    writeBuildConfigFixture(root);
    assert.equal(validateBuildConfiguration(root).appVersion, ANDROID_VERSION_BASE_APP_VERSION);

    writeBuildConfigFixture(root, { cargoVersion: '0.9.46' });
    assert.throws(() => validateBuildConfiguration(root), /Application versions must match/);

    writeBuildConfigFixture(root, { tauriVersion: '0.9.46' });
    assert.throws(() => validateBuildConfiguration(root), /Application versions must match/);

    writeBuildConfigFixture(root, {
      packageVersion: '0.9.46',
      cargoVersion: ANDROID_VERSION_BASE_APP_VERSION,
      tauriVersion: ANDROID_VERSION_BASE_APP_VERSION,
    });
    assert.throws(() => validateBuildConfiguration(root), /Application versions must match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Android properties keep release versionCode separate from internal build number', () => {
  const root = mkdtempSync(join(tmpdir(), 'deep-student-version-'));
  const previousOverride = process.env.DEEP_STUDENT_BUILD_NUMBER;
  const originalLog = console.log;
  const originalWarn = console.warn;
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'src-tauri', 'gen', 'android', 'app'), { recursive: true });
    writeBuildConfigFixture(root);
    writeFileSync(join(root, 'src-tauri', 'gen', 'android', 'app', 'tauri.properties'), '');

    process.env.DEEP_STUDENT_BUILD_NUMBER = String(ANDROID_VERSION_CODE + 27);
    console.log = () => {};
    console.warn = () => {};
    const generated = generateVersionFiles(root);
    assert.equal(generated.buildNumber, String(ANDROID_VERSION_CODE + 27));
    assert.equal(generated.androidVersionCode, ANDROID_VERSION_CODE);

    const properties = readFileSync(
      join(root, 'src-tauri', 'gen', 'android', 'app', 'tauri.properties'),
      'utf-8',
    );
    assert.match(properties, new RegExp(`tauri\\.android\\.versionCode=${ANDROID_VERSION_CODE}\\n`, 'u'));
    assert.doesNotMatch(properties, new RegExp(`versionCode=${ANDROID_VERSION_CODE + 27}`, 'u'));
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

test('local Android build uses release versionCode instead of internal build number', () => {
  const buildScript = readFileSync(join(projectRoot, 'scripts', 'build_android.sh'), 'utf-8');
  assert.match(
    buildScript,
    /ANDROID_VERSION_CODE=\$\(node scripts\/generate-version\.mjs --print-android-version-code\)/u,
  );
  assert.match(buildScript, /TAURI_ANDROID_VERSION_CODE="\$ANDROID_VERSION_CODE"/u);
  assert.match(buildScript, /--config "\$TAURI_ANDROID_CONFIG"/u);
  assert.match(buildScript, /android_ndk_find_prebuilt "\$NDK_HOME"/u);
  assert.match(buildScript, /android_ndk_find_tool "\$NDK_PREBUILT_DIR"/u);
  assert.doesNotMatch(buildScript, /prebuilt\/darwin-x86_64/u);
  assert.doesNotMatch(
    buildScript,
    /apply_android_version_code|TAURI_CONF_BACKUP|CARGO_CONFIG_FILE|config\.toml.*Android NDK/u,
  );
});

test('Rust build metadata uses the same baseline and never counts unrelated refs', () => {
  const buildScript = readFileSync(join(projectRoot, 'src-tauri', 'build.rs'), 'utf-8');
  assert.match(buildScript, /const BUILD_NUMBER_BASE: u32 = 14637;/u);
  assert.match(buildScript, new RegExp(BUILD_NUMBER_BASE_COMMIT, 'u'));
  assert.match(buildScript, /"rev-list",\s*"--count"/u);
  assert.match(buildScript, /verify_application_versions\(\)/u);
  assert.match(buildScript, /cargo:rustc-env=SENTRY_RELEASE=/u);
  assert.doesNotMatch(buildScript, /"--all"|9000 \+/u);
});

test('Sentry release reads the canonical generator instead of recomputing from refs', () => {
  const release = execFileSync(
    process.execPath,
    [join(projectRoot, 'scripts', 'generate-version.mjs'), '--print-sentry-release'],
    { cwd: projectRoot, encoding: 'utf-8' },
  ).trim();
  const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
  assert.equal(
    release,
    formatSentryRelease(
      packageJson.version,
      resolveBuildNumber({ root: projectRoot }),
      resolveGitRevision({ root: projectRoot }),
    ),
  );

  const uploadScript = readFileSync(
    join(projectRoot, 'scripts', 'upload-sentry-symbols.sh'),
    'utf-8',
  );
  assert.match(uploadScript, /generate-version\.mjs" --print-sentry-release/u);
  assert.doesNotMatch(uploadScript, /rev-list --all|9000 \+/u);

  const rustEntry = readFileSync(join(projectRoot, 'src-tauri', 'src', 'lib.rs'), 'utf-8');
  assert.match(
    rustEntry,
    /sentry::ClientOptions\s*\{[\s\S]{0,300}release:\s*Some\(env!\("SENTRY_RELEASE"\)/u,
  );
});
