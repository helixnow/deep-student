import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function prepareBilibiliAndroid(root) {
  const base = path.join(root, 'src-tauri/gen/android/app/src/main');
  const manifestPath = path.join(base, 'AndroidManifest.xml');
  if (!existsSync(manifestPath)) throw new Error('Android project must be initialized first');
  let manifest = readFileSync(manifestPath, 'utf8');
  for (const permission of ['FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_DATA_SYNC', 'POST_NOTIFICATIONS']) {
    const full = `android.permission.${permission}`;
    if (!manifest.includes(`android:name="${full}"`)) manifest = manifest.replace(/(<manifest\b[^>]*>)/, `$1\n    <uses-permission android:name="${full}" />`);
  }
  if (!manifest.includes('com.deepstudent.app.BiliBridgeSessionService')) manifest = manifest.replace('</application>', '<service android:name="com.deepstudent.app.BiliBridgeSessionService" android:exported="false" android:foregroundServiceType="dataSync" /></application>');
  writeFileSync(manifestPath, manifest);
  const sources = path.join(root, 'src-tauri/mobile/android');
  for (const name of ['BiliBridgePlugin.kt', 'BilibiliRangeResponse.kt']) {
    copyFileSync(path.join(sources, name), path.join(base, 'java/com/deepstudent/app', name));
  }
  const app = path.dirname(path.dirname(base));
  const tests = path.join(app, 'src/test/java/com/deepstudent/app');
  mkdirSync(tests, { recursive: true });
  copyFileSync(path.join(sources, 'tests/BilibiliRangeInputStreamTest.kt'), path.join(tests, 'BilibiliRangeInputStreamTest.kt'));
  copyFileSync(path.join(sources, 'bilibili-range.gradle.kts'), path.join(app, 'bilibili-range.gradle.kts'));
  const gradlePath = path.join(app, 'build.gradle.kts');
  const gradle = readFileSync(gradlePath, 'utf8');
  const apply = 'apply(from = "bilibili-range.gradle.kts")';
  if (!gradle.includes(apply)) writeFileSync(gradlePath, `${gradle.trimEnd()}\n\n${apply}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareBilibiliAndroid(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
