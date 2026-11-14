/**
 * 打包产物的加固策略：Electron fuses 与 macOS 签名。打包配置（electron-builder.config.cjs）与打包后校验
 * （verify-fuses.mjs）共用这里的期望值。
 *
 * Fuses（afterPack 中按平台翻转，之后只剩签名；macOS 翻转后先 ad-hoc 重签，原有链接器签名已失效）：
 * - RunAsNode / EnableNodeOptionsEnvironmentVariable / EnableNodeCliInspectArguments 关闭：`ELECTRON_RUN_AS_NODE`、
 *   `NODE_OPTIONS`、`--inspect*` 都不能再把安装包当成通用 Node 运行时或附加调试器。应用自己不依赖这三者：
 *   Host 用 utilityProcess.fork，Windows 沙箱 helper 以 `--deep-student-shell-sandbox-helper` 重启自身。
 * - EnableEmbeddedAsarIntegrityValidation / OnlyLoadAppFromAsar 打开：只从 `app.asar` 启动，并按 electron-builder
 *   写入的头部哈希（macOS Info.plist `ElectronAsarIntegrity`、Windows exe 资源 `INTEGRITY/ELECTRONASAR`）校验；
 *   Linux 上 Electron 不做该校验。
 * - GrantFileProtocolExtraPrivileges 关闭：应用页面走 `tauri://` / `http://tauri.localhost`，不加载 `file://`。
 * - EnableCookieEncryption：Windows（DPAPI，与 WebView2 版相同）与 Linux（libsecret / kwallet，没有时 Chromium 用
 *   固定密钥）打开。macOS 的密钥在钥匙串里，钥匙串项只认创建它的签名：ad-hoc 签名每次更新都变，系统会为此弹授权框，
 *   拒绝后 cookie 全部读不出，所以只在正式签名（Developer ID，按 Team ID 识别）时打开；WKWebView 版的 cookie
 *   本来也不加密。已有的明文 cookie Chromium 照常读取，新写入的加密。
 * 未列出的 fuse 保持 Electron 默认值。
 *
 * macOS 签名（{@link macSigning}）：
 * - 默认 ad-hoc（与 Tauri `signingIdentity: "-"` 相同），开启 hardened runtime：`DYLD_*` 环境变量注入被系统忽略。
 *   ad-hoc 没有 Team ID，必须带 `disable-library-validation` 才能加载包内的原生模块（Tauri 版同样带）。
 * - 设置 `CSC_LINK`（证书文件）或 `CSC_NAME`（钥匙串中的身份）时为正式发布：Developer ID 签名、hardened runtime、
 *   时间戳、公证；不带 `disable-library-validation`（包内所有 Mach-O 都由同一 Team ID 签名）。
 */
'use strict';

const path = require('node:path');

const COMMON_FUSES = Object.freeze({
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  GrantFileProtocolExtraPrivileges: false,
});

/** 目标平台（electron 平台名：darwin / win32 / linux）与签名方式下的 fuse 期望值，键为 FuseV1Options 名称。 */
function expectedFuses(platform, { signed = false } = {}) {
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw new Error(`unknown platform ${platform}`);
  return { ...COMMON_FUSES, EnableCookieEncryption: platform !== 'darwin' || signed };
}

/** `@electron/fuses` 的 FuseConfig（electron-builder `packager.addElectronFuses`）。 */
function fuseConfig(platform, options) {
  const { FuseVersion, FuseV1Options } = require('@electron/fuses');
  const config = { version: FuseVersion.V1, resetAdHocDarwinSignature: platform === 'darwin' };
  for (const [name, value] of Object.entries(expectedFuses(platform, options))) config[FuseV1Options[name]] = value;
  return config;
}

/** 正式发布签名：electron-builder 从 `CSC_LINK` / `CSC_NAME` 取 Developer ID 证书。 */
const isReleaseSigning = (env) => Boolean(env.CSC_LINK || env.CSC_NAME);

/** 兼容 legacy `APPLE_PASSWORD` 与 electron-builder 标准 `APPLE_APP_SPECIFIC_PASSWORD`。 */
const resolveAppleAppSpecificPassword = (env) => env.APPLE_APP_SPECIFIC_PASSWORD || env.APPLE_PASSWORD || '';

/** 把 legacy `APPLE_PASSWORD` 补齐为 `APPLE_APP_SPECIFIC_PASSWORD`，供 electron-builder 公证读取。 */
function normalizeNotarizeEnv(env) {
  if (env.APPLE_PASSWORD && !env.APPLE_APP_SPECIFIC_PASSWORD) {
    return { ...env, APPLE_APP_SPECIFIC_PASSWORD: env.APPLE_PASSWORD };
  }
  return env;
}

/** 公证凭据（electron-builder `MacTargetHelper.getNotarizeOptions` 认的三组环境变量之一）。 */
function hasNotarizeCredentials(env) {
  return Boolean((env.APPLE_ID && resolveAppleAppSpecificPassword(env) && env.APPLE_TEAM_ID)
    || (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)
    || env.APPLE_KEYCHAIN_PROFILE);
}

/** electron-builder `mac` 中与签名有关的字段。 */
function macSigning(env, projectDir) {
  const buildDir = path.join(projectDir, 'electron', 'signing');
  if (isReleaseSigning(env)) {
    const entitlements = path.join(buildDir, 'entitlements.mac.plist');
    return { signed: true, mac: { hardenedRuntime: true, entitlements, entitlementsInherit: entitlements, notarize: true } };
  }
  const entitlements = path.join(buildDir, 'entitlements.mac.adhoc.plist');
  // `--timestamp=none`：ad-hoc 签名不需要时间戳，也不联系 Apple 的时间戳服务器。
  return { signed: false, mac: { identity: '-', hardenedRuntime: true, entitlements, entitlementsInherit: entitlements, timestamp: 'none', notarize: false } };
}

module.exports = {
  COMMON_FUSES,
  expectedFuses,
  fuseConfig,
  hasNotarizeCredentials,
  isReleaseSigning,
  macSigning,
  normalizeNotarizeEnv,
  resolveAppleAppSpecificPassword,
};
