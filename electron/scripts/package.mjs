#!/usr/bin/env node
/**
 * 打包 Electron 外壳（默认当前平台；`--mac`/`--win`/`--linux` 显式选择）。
 *
 * - 签名：mac 默认 ad-hoc + hardened runtime（`CSC_IDENTITY_AUTO_DISCOVERY=false`）；设置 `CSC_LINK`/`CSC_NAME` 时
 *   正式签名并公证，缺公证凭据直接失败（scripts/app-hardening.cjs）；Windows 不签名，exe 的图标与版本信息照常写入
 *   （asar 完整性资源照常写入 exe）；
 * - 先构建沙箱 preload 与 `electron/.build/version.json`（打包后没有 git，`get_app_version` 依赖它）；
 * - `--dir` 只产出未压缩目录（用于本地验收与 migrations 校验）；
 * - 打包后自动校验 `Resources/migrations` 与 `resources/app/migrations` 逐字节一致，且生产依赖闭包（含嵌套版本）每个包都在 app.asar 中。
 *
 * 示例：`node electron/scripts/package.mjs --mac --dir`
 * 外置盘：`DS_ELECTRON_PACKAGE_OUTPUT=/Volumes/DSWork/<new-directory> ...`（打包后校验也使用此目录）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPreload } from './build-preload.mjs';
import { buildInfo, writeBundledSentryDsn } from '../build-info.ts';
import { verifyMigrations } from '../migrations-integrity.ts';
import { resolveBuildNumber, resolveGitRevision } from '../../scripts/generate-version.mjs';

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));
const known = new Set(['--mac', '--win', '--linux', '--arm64', '--x64', '--dir', '--skip-verify']);
for (const flag of flags) if (!known.has(flag)) throw new Error(`unknown option ${flag}`);
if (flags.has('--arm64') && flags.has('--x64')) throw new Error('--arm64 and --x64 cannot be combined');

const targetArch = flags.has('--arm64') ? 'arm64' : flags.has('--x64') ? 'x64' : process.arch;
process.env.DS_TARGET_ARCH = targetArch;

const electronDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(electronDir, '..');
const require = createRequire(import.meta.url);
const { hasNotarizeCredentials, isReleaseSigning, normalizeNotarizeEnv } = require('./app-hardening.cjs');
const config = require('../electron-builder.config.cjs');
const { collectProductionClosure } = require('./node-modules-closure.cjs');
const { listPackage } = require('@electron/asar');

const platform = flags.has('--mac')
  ? 'mac'
  : flags.has('--win')
    ? 'win'
    : flags.has('--linux')
      ? 'linux'
      : process.platform === 'darwin'
        ? 'mac'
        : process.platform === 'win32'
          ? 'win'
          : 'linux';

function hostPlatform() {
  return process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
}

/**
 * `electron/build-info.ts` 优先读取 `electron/.build/version.json`；打包产物没有 git 仓库，
 * 必须在打包时固化 build number/hash（公式与 `src-tauri/build.rs` 一致）。
 */
function ensureVersionInfo() {
  const target = join(electronDir, '.build', 'version.json');
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  let buildNumber;
  try {
    buildNumber = resolveBuildNumber({ root, env: process.env });
  } catch (error) {
    // 无完整 git 历史（例如浅克隆）且未显式传入 DEEP_STUDENT_BUILD_NUMBER 时，
    // 仅在既有 version.json 与当前版本号及格式校验完全匹配时复用。
    if (process.env.DEEP_STUDENT_BUILD_NUMBER === undefined && existsSync(target)) {
      buildInfo(root, version);
      return { target, version };
    }
    throw error;
  }
  const gitRevision = resolveGitRevision({ root });
  const gitHash = gitRevision === 'unknown' ? gitRevision : gitRevision.slice(0, 8);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ version, buildNumber, gitHash, gitRevision }, null, 2)}\n`);
  return { target, version };
}

function findResources() {
  const release = resolve(root, config.directories.output);
  const candidates = [];
  const preferredMacDir = targetArch === 'arm64' ? 'mac-arm64' : targetArch === 'x64' ? 'mac' : `mac-${targetArch}`;
  const preferredOtherDir = platform === 'win'
    ? (targetArch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked')
    : (targetArch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked');
  for (const name of readdirSync(release, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    if (platform === 'mac' && name.name === preferredMacDir) {
      candidates.unshift(join(release, name.name, `${config.productName}.app`, 'Contents', 'Resources'));
    } else if (platform === 'mac' && name.name.startsWith('mac')) {
      candidates.push(join(release, name.name, `${config.productName}.app`, 'Contents', 'Resources'));
    }
    if (platform !== 'mac' && name.name === preferredOtherDir) {
      candidates.unshift(join(release, name.name, 'resources'));
    } else if (platform === 'win' && name.name.endsWith('-unpacked') && name.name.startsWith('win')) {
      candidates.push(join(release, name.name, 'resources'));
    } else if (platform === 'linux' && name.name.endsWith('-unpacked') && name.name.startsWith('linux')) {
      candidates.push(join(release, name.name, 'resources'));
    }
  }
  return candidates.find((path) => existsSync(join(path, 'migrations'))) ?? null;
}

await buildPreload();
const { version: appVersion } = ensureVersionInfo();
process.stdout.write(`[package] backend Sentry DSN ${writeBundledSentryDsn(root, process.env) ? 'embedded from SENTRY_DSN' : 'not embedded (SENTRY_DSN unset)'}\n`);
if (!existsSync(join(root, 'dist', 'index.html'))) {
  process.stderr.write('[package] dist/index.html 不存在：先执行 `npm run build`，否则窗口会加载空白页。\n');
}

const cli = require.resolve('electron-builder/out/cli/cli.js');
const argv = [
  cli,
  '--config', join(electronDir, 'electron-builder.config.cjs'),
  `--${platform}`,
  ...(targetArch === 'arm64' ? ['--arm64'] : targetArch === 'x64' ? ['--x64'] : []),
  ...(flags.has('--dir') ? ['--dir'] : []),
  // 本机同架构直接用已安装的 Electron 发行目录，不联网下载 electron-vX-<platform>-<arch>.zip。
  ...(platform === hostPlatform() && targetArch === process.arch
    ? [`-c.electronDist=${join(dirname(require.resolve('electron')), 'dist')}`]
    : []),
];
const baseEnv = normalizeNotarizeEnv(process.env);
const releaseSigning = platform === 'mac' && isReleaseSigning(baseEnv);
if (releaseSigning && !hasNotarizeCredentials(baseEnv)) {
  // electron-builder 缺凭据时只告警并跳过公证；未公证的 Developer ID 包会被 Gatekeeper 拦下。
  process.stderr.write('[package] CSC_LINK/CSC_NAME 已设置（正式签名）但缺公证凭据：APPLE_ID + (APPLE_APP_SPECIFIC_PASSWORD|APPLE_PASSWORD) + APPLE_TEAM_ID、'
    + 'APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER 或 APPLE_KEYCHAIN_PROFILE。\n');
  process.exit(1);
}
const result = spawnSync(process.execPath, argv, {
  cwd: root,
  stdio: 'inherit',
  // ad-hoc 时不让 electron-builder 去钥匙串里自动挑 Developer ID；正式签名可能只给了 CSC_LINK，需要自动发现。
  env: releaseSigning ? baseEnv : { ...baseEnv, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});
if (result.status !== 0) process.exit(result.status ?? 1);

if (platform === 'mac' && !flags.has('--dir')) {
  const releaseDir = resolve(root, config.directories.output);
  const macDir = join(releaseDir, targetArch === 'arm64' ? 'mac-arm64' : targetArch === 'x64' ? 'mac' : `mac-${targetArch}`);
  const appName = `${config.productName}.app`;
  const appPath = join(macDir, appName);
  if (!existsSync(appPath)) throw new Error(`signed macOS app bundle not found: ${appPath}`);
  const tauriArch = targetArch === 'arm64' ? 'aarch64' : targetArch === 'x64' ? 'x86_64' : targetArch;
  const archivePath = join(releaseDir, `Deep.Student_${appVersion}_${tauriArch}.app.tar.gz`);
  rmSync(archivePath, { force: true });
  execFileSync('tar', ['-czf', archivePath, '-C', macDir, appName], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: 'inherit',
  });
  process.stdout.write(`[package] macOS updater archive created: ${archivePath}\n`);
}

if (!flags.has('--skip-verify')) {
  const resources = findResources();
  if (resources === null) throw new Error(`packaged resources not found under ${resolve(root, config.directories.output)}`);
  const problems = verifyMigrations(resolve(root, 'resources/app', 'migrations'), join(resources, 'migrations'));
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`[migrations] ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(`[migrations] ${join(resources, 'migrations')} 与源目录逐字节一致\n`);

  const target = { platform: { mac: 'darwin', win: 'win32', linux: 'linux' }[platform], arch: targetArch };
  const closure = collectProductionClosure(root, target);
  const archive = join(resources, 'app.asar');
  const packed = new Set(listPackage(archive, { isPack: false }).map((entry) => entry.split(sep).join('/')));
  const missing = [...closure.keys()].filter((key) => {
    const manifest = `node_modules/${key}/package.json`;
    return !packed.has(`/${manifest}`) && !existsSync(join(`${archive}.unpacked`, manifest));
  });
  if (missing.length > 0) {
    for (const key of missing) process.stderr.write(`[node_modules] 运行时依赖未进包：${key}\n`);
    process.exit(1);
  }
  process.stdout.write(`[node_modules] 生产依赖闭包 ${closure.size} 个包（含嵌套版本）全部在 app.asar 中\n`);

  const sqliteBusy = '/host/platform/native/sqlite-busy/';
  const testOnly = [...packed].filter((entry) => entry.startsWith(sqliteBusy) && !/^(index|api)\.ts$/.test(entry.slice(sqliteBusy.length)));
  if (existsSync(join(`${archive}.unpacked`, sqliteBusy))) testOnly.push(`app.asar.unpacked${sqliteBusy}`);
  if (testOnly.length > 0) {
    for (const entry of testOnly) process.stderr.write(`[test-only] 只供测试的文件进了产品：${entry}\n`);
    process.exit(1);
  }
  process.stdout.write('[test-only] f7-sqlite-busy 预编译与源码未进包\n');
}
