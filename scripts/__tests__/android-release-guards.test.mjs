import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PUBLISHED_ANDROID_VERSION_CODE, resolveAndroidVersionCode } from '../generate-version.mjs';
import { patchBuildTask } from '../ci/prepare-android-gradle.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readProject = (file) => readFileSync(path.join(project, file), 'utf8');

// #471: v0.9.61 起签名证书随 keystore secret 更换而变化，存量用户覆盖安装报
// "与现有软件包存在冲突"。发布流水线必须校验受控指纹与 versionCode 单调。

test('pinned Android signing certificate is a single SHA-256 fingerprint', () => {
  const lines = readProject('src-tauri/mobile/android/release-signing-cert.sha256')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^[0-9a-f]{64}$/u);
});

test('Sign APK step enforces the pinned certificate and versionCode before publishing', () => {
  const workflow = readProject('.github/workflows/reusable-build-android.yml');
  const certGuard = workflow.indexOf('src-tauri/mobile/android/release-signing-cert.sha256');
  const codeGuard = workflow.indexOf('--print-android-version-code');
  const publish = workflow.indexOf('cp /tmp/signed.apk "android-output/');
  assert.ok(certGuard > 0, 'missing signing certificate guard');
  assert.ok(codeGuard > 0, 'missing versionCode guard');
  assert.ok(publish > certGuard && publish > codeGuard, 'guards must run before the APK is staged for release');
  assert.match(workflow, /Signer #1 certificate SHA-256 digest/u);
  assert.match(workflow, /PUBLISHED_ANDROID_VERSION_CODE/u);
});

test('Android versionCode stays monotonic across published release lines', () => {
  const versions = ['0.9.55', '0.9.61', '0.9.73', '0.10.0', '0.10.5', '0.11.0', '1.0.0'];
  const codes = versions.map((version) => resolveAndroidVersionCode(version));
  assert.equal(codes[1], 14647, 'v0.9.61 shipped with versionCode 14647');
  assert.equal(codes[4], 114591, 'v0.10.5 shipped with versionCode 114591');
  for (let i = 0; i < codes.length; i += 1) {
    assert.ok(codes[i] > PUBLISHED_ANDROID_VERSION_CODE);
    if (i > 0) assert.ok(codes[i] > codes[i - 1], `${versions[i]} must exceed ${versions[i - 1]}`);
  }
});

test('prebuilt JNI validation follows an isolated Cargo target and retains native guards', () => {
  const patched=patchBuildTask('class BuildTask { fun assemble() { buildNative() } }');
  assert.match(patched,/System\.getenv\("CARGO_TARGET_DIR"\)/u);
  assert.match(patched,/if \(it\.isAbsolute\) it else File\(root, configuredTarget\)/u);
  assert.match(patched,/jni\.canonicalFile != lib\.canonicalFile/u);
  assert.match(patched,/Java_app_tauri_plugin_PluginManager_handlePluginResponse/u);
  assert.equal(patchBuildTask(patched),patched);
});
