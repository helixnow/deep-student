#!/usr/bin/env node
// 生成版本信息，并同步到 Android 的生成目录。
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Android 的商店发布号显式固定在 tracked config 中；内部 build number
// 只计算 nightly 基线之后从 HEAD 可达的提交，避免 --all 因 refs 不同而漂移。
export const PUBLISHED_ANDROID_VERSION_CODE = 14636;
export const ANDROID_VERSION_CODE = 14637;
export const ANDROID_VERSION_BASE_APP_VERSION = '0.9.44';
export const BUILD_NUMBER_BASE = 14636;
export const BUILD_NUMBER_BASE_COMMIT = '31834cbfcba6660890bfb3b29914ea6ec80b2e8d';
export const ANDROID_VERSION_CODE_MAX = 2_100_000_000;
const SEMVER_MAJOR_STRIDE = 10_000_000;
const SEMVER_MINOR_STRIDE = 100_000;

function parseVersionCode(value, source) {
  if (typeof value === 'string' && !/^[0-9]+$/u.test(value)) {
    throw new Error(`${source} must contain decimal digits only`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > ANDROID_VERSION_CODE_MAX) {
    throw new Error(`${source} must be an integer between 1 and ${ANDROID_VERSION_CODE_MAX}`);
  }
  return parsed;
}

export function buildNumberFromCommitCount(commitCount) {
  if (!Number.isSafeInteger(commitCount) || commitCount < 0) {
    throw new Error('commitCount must be a non-negative integer');
  }

  const buildNumber = BUILD_NUMBER_BASE + commitCount;
  return parseVersionCode(buildNumber, 'generated build number');
}

function semverOrdinal(version, source) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (!match) {
    throw new Error(`${source} must be a stable major.minor.patch semantic version`);
  }
  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch) ||
    minor >= 100 ||
    patch >= SEMVER_MINOR_STRIDE
  ) {
    throw new Error(`${source} exceeds the supported Android version mapping`);
  }
  return major * SEMVER_MAJOR_STRIDE + minor * SEMVER_MINOR_STRIDE + patch;
}

export function resolveAndroidVersionCode(appVersion) {
  const baseOrdinal = semverOrdinal(
    ANDROID_VERSION_BASE_APP_VERSION,
    'ANDROID_VERSION_BASE_APP_VERSION',
  );
  const appOrdinal = semverOrdinal(appVersion, 'package.json version');
  if (appOrdinal < baseOrdinal) {
    throw new Error(
      `package.json version ${appVersion} predates Android baseline ${ANDROID_VERSION_BASE_APP_VERSION}`,
    );
  }
  return parseVersionCode(
    ANDROID_VERSION_CODE + (appOrdinal - baseOrdinal),
    'generated Android versionCode',
  );
}

function runGit(args, root = projectRoot) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function resolveGitRevision({
  root = projectRoot,
  git = (args) => runGit(args, root),
} = {}) {
  try {
    const revision = git(['rev-parse', 'HEAD']).toLowerCase();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(revision)) {
      throw new Error(`invalid Git revision: ${JSON.stringify(revision)}`);
    }
    return revision;
  } catch {
    return 'unknown';
  }
}

export function formatSentryRelease(appVersion, buildNumber, gitRevision) {
  semverOrdinal(appVersion, 'Sentry app version');
  const normalizedBuildNumber = parseVersionCode(buildNumber, 'Sentry build number');
  if (
    gitRevision !== 'unknown' &&
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(gitRevision)
  ) {
    throw new Error('Sentry Git revision must be a full hexadecimal commit ID or "unknown"');
  }
  return `${appVersion}+${normalizedBuildNumber}.${gitRevision}`;
}

export function resolveBuildNumber({
  root = projectRoot,
  env = process.env,
  git = (args) => runGit(args, root),
} = {}) {
  if (env.DEEP_STUDENT_BUILD_NUMBER !== undefined) {
    const overridden = parseVersionCode(
      env.DEEP_STUDENT_BUILD_NUMBER,
      'DEEP_STUDENT_BUILD_NUMBER',
    );
    if (overridden <= BUILD_NUMBER_BASE) {
      throw new Error(
        `DEEP_STUDENT_BUILD_NUMBER must be greater than ${BUILD_NUMBER_BASE}`,
      );
    }
    return overridden;
  }

  try {
    git(['cat-file', '-e', `${BUILD_NUMBER_BASE_COMMIT}^{commit}`]);
  } catch {
    throw new Error(
      `Git history does not contain build baseline ${BUILD_NUMBER_BASE_COMMIT}. ` +
        'Fetch full history or set DEEP_STUDENT_BUILD_NUMBER explicitly.',
    );
  }

  try {
    git(['merge-base', '--is-ancestor', BUILD_NUMBER_BASE_COMMIT, 'HEAD']);
  } catch {
    throw new Error(
      `HEAD must descend from build baseline ${BUILD_NUMBER_BASE_COMMIT}. ` +
        'Set DEEP_STUDENT_BUILD_NUMBER explicitly for an independent release line.',
    );
  }

  const rawCount = git([
    'rev-list',
    '--count',
    `${BUILD_NUMBER_BASE_COMMIT}..HEAD`,
  ]);
  const commitCount = Number(rawCount);
  if (!Number.isSafeInteger(commitCount) || commitCount < 0) {
    throw new Error(`Git returned an invalid commit count: ${JSON.stringify(rawCount)}`);
  }

  const buildNumber = buildNumberFromCommitCount(commitCount);
  if (buildNumber <= BUILD_NUMBER_BASE) {
    throw new Error(
      `Generated build number ${buildNumber} must be greater than ${BUILD_NUMBER_BASE}`,
    );
  }
  return buildNumber;
}

function writeIfChanged(filePath, content) {
  if (existsSync(filePath)) {
    const current = readFileSync(filePath, 'utf-8');
    if (current === content) {
      return false;
    }
  }

  writeFileSync(filePath, content, 'utf-8');
  return true;
}

export function validateBuildConfiguration(root = projectRoot) {
  const cargoConfigPath = join(root, 'src-tauri', '.cargo', 'config.toml');
  const cargoConfig = readFileSync(cargoConfigPath, 'utf-8');
  if (/^\s*proxy\s*=/mu.test(cargoConfig)) {
    throw new Error(
      `${cargoConfigPath} must not contain a repository-level proxy; use CARGO_HTTP_PROXY or HTTPS_PROXY`,
    );
  }
  if (/^\s*\[target\.[^\]]+-linux-android\]\s*$/mu.test(cargoConfig)) {
    throw new Error(
      `${cargoConfigPath} must not contain a machine-specific Android toolchain; use CARGO_TARGET_* environment variables`,
    );
  }

  const tauriConfigPath = join(root, 'src-tauri', 'tauri.conf.json');
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf-8'));
  const appVersion = readAppVersion(root);
  const cargoVersion = readCargoPackageVersion(root);
  const tauriVersion = tauriConfig?.version;
  if (typeof tauriVersion !== 'string' || tauriVersion.length === 0) {
    throw new Error('tauri.conf.json version must be a non-empty string');
  }
  if (appVersion !== cargoVersion || appVersion !== tauriVersion) {
    throw new Error(
      `Application versions must match: package.json=${appVersion}, Cargo.toml=${cargoVersion}, tauri.conf.json=${tauriVersion}`,
    );
  }
  resolveAndroidVersionCode(appVersion);

  const configuredVersionCode = parseVersionCode(
    tauriConfig?.bundle?.android?.versionCode,
    'tauri.conf.json bundle.android.versionCode',
  );
  if (configuredVersionCode !== ANDROID_VERSION_CODE) {
    throw new Error(
      `tauri.conf.json Android versionCode must be ${ANDROID_VERSION_CODE}, got ${configuredVersionCode}`,
    );
  }

  return { androidVersionCode: configuredVersionCode, appVersion };
}

function readAppVersion(root = projectRoot) {
  const packageJsonPath = join(root, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('package.json version must be a non-empty string');
  }
  return packageJson.version;
}

function readCargoPackageVersion(root = projectRoot) {
  const cargoTomlPath = join(root, 'src-tauri', 'Cargo.toml');
  const lines = readFileSync(cargoTomlPath, 'utf-8').split(/\r?\n/u);
  let inPackageSection = false;
  let packageVersion;

  for (const line of lines) {
    const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
    if (section) {
      inPackageSection = section[1].trim() === 'package';
      continue;
    }
    if (!inPackageSection || !/^\s*version\s*=/u.test(line)) continue;

    const version = /^\s*version\s*=\s*"([^"\\]+)"\s*(?:#.*)?$/u.exec(line);
    if (!version || packageVersion !== undefined) {
      throw new Error(`${cargoTomlPath} must contain one literal [package].version`);
    }
    packageVersion = version[1];
  }

  if (packageVersion === undefined) {
    throw new Error(`${cargoTomlPath} is missing a literal [package].version`);
  }
  return packageVersion;
}

export function generateVersionFiles(root = projectRoot) {
  const { appVersion } = validateBuildConfiguration(root);
  const androidVersionCode = resolveAndroidVersionCode(appVersion);
  const buildNumber = String(resolveBuildNumber({ root }));
  const gitRevision = resolveGitRevision({ root });
  const gitHash = gitRevision === 'unknown' ? gitRevision : gitRevision.slice(0, 8);
  const sentryRelease = formatSentryRelease(appVersion, buildNumber, gitRevision);

  const versionTsContent = `// 此文件由 scripts/generate-version.mjs 自动生成，请勿手动修改
export const VERSION_INFO = {
  APP_VERSION: '${appVersion}', // 应用主版本号
  BUILD_NUMBER: '${buildNumber}', // 内部版本号
  GIT_HASH: '${gitHash}', // Git commit short hash
  FULL_VERSION: '${appVersion} (${buildNumber})', // 完整版本号
  SENTRY_RELEASE: '${sentryRelease}', // Sentry release 标识
} as const;

export default VERSION_INFO;
`;

  const versionTsPath = join(root, 'src', 'version.ts');
  writeIfChanged(versionTsPath, versionTsContent);

  console.log('Version info generated:');
  console.log(`   App version: ${appVersion}`);
  console.log(`   Build number: ${buildNumber}`);
  console.log(`   Android versionCode: ${androidVersionCode}`);
  console.log(`   Git hash: ${gitHash}`);
  console.log(`   Full version: ${appVersion} (${buildNumber})`);
  console.log(`   Sentry release: ${sentryRelease}`);
  console.log(`   File: ${versionTsPath}`);

  // tauri android init creates this ignored file. beforeBuildCommand runs the
  // generator again, so Android builds receive the same stable versionCode.
  const tauriPropertiesPath = join(
    root,
    'src-tauri',
    'gen',
    'android',
    'app',
    'tauri.properties',
  );
  if (existsSync(tauriPropertiesPath)) {
    const tauriPropertiesContent = `// THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
tauri.android.versionName=${appVersion}
tauri.android.versionCode=${androidVersionCode}
`;
    writeIfChanged(tauriPropertiesPath, tauriPropertiesContent);
    console.log(`   Android properties: ${tauriPropertiesPath}`);
  }

  return { appVersion, buildNumber, gitHash, gitRevision, sentryRelease, androidVersionCode };
}

function main() {
  if (process.argv.includes('--print-build-number')) {
    validateBuildConfiguration();
    process.stdout.write(`${resolveBuildNumber()}\n`);
    return;
  }

  if (process.argv.includes('--print-android-version-code')) {
    const { appVersion } = validateBuildConfiguration();
    const androidVersionCode = resolveAndroidVersionCode(appVersion);
    process.stdout.write(`${androidVersionCode}\n`);
    return;
  }

  if (process.argv.includes('--print-sentry-release')) {
    const { appVersion } = validateBuildConfiguration();
    process.stdout.write(
      `${formatSentryRelease(appVersion, resolveBuildNumber(), resolveGitRevision())}\n`,
    );
    return;
  }

  if (process.argv.includes('--check')) {
    const { appVersion } = validateBuildConfiguration();
    const androidVersionCode = resolveAndroidVersionCode(appVersion);
    const buildNumber = resolveBuildNumber();
    console.log(
      `Build configuration valid: android=${androidVersionCode}, build=${buildNumber}, publishedAndroid=${PUBLISHED_ANDROID_VERSION_CODE}`,
    );
    return;
  }

  generateVersionFiles();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === __filename) {
  main();
}
