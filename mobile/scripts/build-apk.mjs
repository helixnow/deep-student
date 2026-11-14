#!/usr/bin/env node
/**
 * Build the full frontend, sync Capacitor, and produce an APK. No Android Studio needed.
 *
 * `--release` builds an unsigned release APK and signs it with the published release key:
 * zipalign (16 KiB pages) → apksigner → certificate fingerprint check against
 * `resources/app/android/release-signing-cert.sha256`. Passwords only ever travel through the
 * child process environment, never argv or stdout.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveAndroidVersionCode, validateBuildConfiguration } from '../../scripts/generate-version.mjs';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(mobile, '..');
const android = join(mobile, 'android');
const args = process.argv.slice(2);
let release = false;
let output;
let cleanAndroid = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--clean-android') cleanAndroid = true;
  else if (args[i] === '--release') release = true;
  else if (args[i] === '--output' && args[i + 1]) output = resolve(args[++i]);
  else if (args[i] === '--help') {
    console.log('Usage: node mobile/scripts/build-apk.mjs [--release] [--output PATH] [--clean-android]');
    console.log('');
    console.log('  --release   Build and sign a release APK (release keystore, verified certificate).');
    console.log('  --output    Destination file. Defaults to mobile/dist/deep-student-{debug,release}.apk');
    console.log('  --clean-android  Delete the generated android/ project when the build ends.');
    console.log('');
    console.log('Release signing credentials come from ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD,');
    console.log('ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD, falling back to ~/.android/release.keystore.credentials');
    console.log('(lines: keystore=, alias=, storepass=, keypass=).');
    process.exit(0);
  } else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
}
output ??= join(mobile, release ? 'dist/deep-student-release.apk' : 'dist/deep-student-debug.apk');
const relOutput = relative(android, output);
if (relOutput === '' || (!relOutput.startsWith('..') && !isAbsolute(relOutput))) {
  throw new Error('--output must be outside android/ so it survives --clean-android');
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
function execOptions(command, options) {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
    ? { ...options, shell: true }
    : options;
}
function run(command, argv, cwd = mobile, env = process.env) {
  execFileSync(command, argv, execOptions(command, { cwd, env, stdio: 'inherit' }));
}

function javaVersion(home) {
  if (!home || !existsSync(join(home, 'release'))) return 0;
  const version = readFileSync(join(home, 'release'), 'utf8').match(/^JAVA_VERSION="(\d+)/m);
  return Number(version?.[1] ?? 0);
}

function detectJava() {
  const candidates = [process.env.JAVA_HOME];
  if (process.platform === 'darwin') {
    try {
      candidates.push(execFileSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    } catch { /* Homebrew JDKs may not be registered with java_home. */ }
    candidates.push('/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home', '/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home');
    const cellar = '/opt/homebrew/Cellar/openjdk@21';
    if (existsSync(cellar)) for (const version of readdirSync(cellar).sort().reverse()) candidates.push(join(cellar, version, 'libexec/openjdk.jdk/Contents/Home'));
  }
  const linuxJdks = '/usr/lib/jvm';
  if (existsSync(linuxJdks)) for (const dir of readdirSync(linuxJdks)) candidates.push(join(linuxJdks, dir));
  const jdk21 = candidates.find(home => javaVersion(home) === 21);
  if (jdk21) return jdk21;
  candidates.push('/opt/homebrew/Cellar/openjdk@17/17.0.20.1/libexec/openjdk.jdk/Contents/Home', '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home');
  const jdk17 = candidates.find(home => javaVersion(home) === 17);
  if (jdk17) return jdk17;
  throw new Error('JDK 21 (preferred) or JDK 17 is required. Install one or set JAVA_HOME.');
}

function cachedGradleZip() {
  const cache = join(process.env.GRADLE_USER_HOME ?? join(homedir(), '.gradle'), 'wrapper/dists/gradle-8.14.3-bin');
  if (!existsSync(cache)) return undefined;
  for (const entry of readdirSync(cache)) {
    const zip = join(cache, entry, 'gradle-8.14.3-bin.zip');
    if (existsSync(zip)) return zip;
  }
}

function property(value) {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

/** Published release certificate fingerprint; signing with any other key breaks upgrades for existing users. */
const RELEASE_CERT_FILE = join(mobile, '../resources/app/android/release-signing-cert.sha256');
const CREDENTIALS_FILE = join(homedir(), '.android/release.keystore.credentials');
const BUILD_TOOLS_VERSION = '36.0.0';

function expandHome(value) {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

function parseCredentials(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) continue;
    const at = entry.indexOf('=');
    if (at > 0) values[entry.slice(0, at).trim()] = entry.slice(at + 1).trim();
  }
  return values;
}

/**
 * Keystore, alias and passwords: environment variables win, `~/.android/release.keystore.credentials`
 * fills the gaps. Only the keystore path and alias are ever logged.
 */
function releaseCredentials() {
  const fromFile = existsSync(CREDENTIALS_FILE) ? parseCredentials(readFileSync(CREDENTIALS_FILE, 'utf8')) : {};
  const credentials = {
    keystore: expandHome(process.env.ANDROID_KEYSTORE_PATH || fromFile.keystore || ''),
    alias: process.env.ANDROID_KEY_ALIAS || fromFile.alias || '',
    storepass: process.env.ANDROID_KEYSTORE_PASSWORD || fromFile.storepass || '',
    keypass: process.env.ANDROID_KEY_PASSWORD || fromFile.keypass || '',
  };
  const names = { keystore: 'ANDROID_KEYSTORE_PATH / keystore', alias: 'ANDROID_KEY_ALIAS / alias', storepass: 'ANDROID_KEYSTORE_PASSWORD / storepass', keypass: 'ANDROID_KEY_PASSWORD / keypass' };
  const missing = Object.keys(names).filter(key => !credentials[key]).map(key => names[key]);
  if (missing.length > 0) throw new Error(`Release signing needs ${missing.join(', ')} (env or ${CREDENTIALS_FILE}).`);
  if (!existsSync(credentials.keystore)) throw new Error(`Release keystore not found: ${credentials.keystore}`);
  return credentials;
}

function toolBinary(dir, name) {
  if (process.platform !== 'win32') return join(dir, name);
  for (const ext of ['.exe', '.bat', '.cmd', '']) {
    const candidate = join(dir, `${name}${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return join(dir, name);
}

function buildTools(sdk) {
  const dir = join(sdk, `build-tools/${BUILD_TOOLS_VERSION}`);
  const zipalign = toolBinary(dir, 'zipalign');
  const apksigner = toolBinary(dir, 'apksigner');
  if (!existsSync(zipalign) || !existsSync(apksigner)) {
    throw new Error(`Android build-tools ${BUILD_TOOLS_VERSION} (zipalign, apksigner) is required at ${dir}.`);
  }
  return { dir, zipalign, apksigner };
}

/** zipalign → apksigner. Passwords go through `env`, so neither argv nor logs can leak them. */
function signReleaseApk(sdk, unsigned, output, env) {
  const tools = buildTools(sdk);
  const credentials = releaseCredentials();
  const aligned = `${output}.aligned.apk`;
  mkdirSync(dirname(output), { recursive: true });
  try {
    run(tools.zipalign, ['-P', '16', '-v', '4', unsigned, aligned], mobile, env);
    run(
      tools.apksigner,
      [
        'sign',
        '--ks', credentials.keystore,
        '--ks-key-alias', credentials.alias,
        '--ks-pass', 'env:KS_PASS',
        '--key-pass', 'env:KEY_PASS',
        '--in', aligned,
        '--out', output,
      ],
      mobile,
      { ...env, KS_PASS: credentials.storepass, KEY_PASS: credentials.keypass },
    );
  } finally {
    rmSync(aligned, { force: true });
  }
  console.log(`Signed with alias "${credentials.alias}" from ${credentials.keystore}`);
  verifyReleaseSignature(sdk, output, env);
}

/** Refuse to ship an APK whose certificate differs from the published fingerprint. */
function verifyReleaseSignature(sdk, apk, env) {
  const expected = readFileSync(RELEASE_CERT_FILE, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .pop()?.toLowerCase();
  if (!expected) throw new Error(`build-apk: no certificate fingerprint in ${RELEASE_CERT_FILE}`);
  const { apksigner } = buildTools(sdk);
  const report = execFileSync(apksigner, ['verify', '--print-certs', apk], execOptions(apksigner, { encoding: 'utf8', env }));
  for (const line of report.split(/\r?\n/)) if (line.includes('Signer #1 certificate')) console.log(line.trim());
  const digest = report.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]+)/)?.[1]?.toLowerCase();
  if (!digest) throw new Error('build-apk: apksigner reported no Signer #1 certificate SHA-256 digest');
  if (digest !== expected) {
    throw new Error(`build-apk: signed APK certificate ${digest} does not match the published release key ${expected}`);
  }
  console.log(`Certificate SHA-256 matches ${RELEASE_CERT_FILE}`);
  return digest;
}

/**
 * Package identity shipped to phones. `mobile/android/` is generated by `cap add` / replaced by
 * `--clean-android`, so every build re-applies these settings after `cap sync` instead of relying on
 * whatever happens to be committed.
 */
const APP_ID = 'com.deepstudent.app';
const APP_NAME = 'Deep Student';
const ANDROID_PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.REQUEST_INSTALL_PACKAGES',
];

function resolveAndroidAppVersion() {
  const { appVersion } = validateBuildConfiguration(repoRoot);
  return {
    versionName: appVersion,
    versionCode: resolveAndroidVersionCode(appVersion),
  };
}

function replaceRequired(text, pattern, replacement, label) {
  if (!pattern.test(text)) throw new Error(`build-apk: cannot patch ${label}: pattern not found`);
  return text.replace(pattern, replacement);
}

/** `applicationId` / `versionCode` / `versionName` in `android/app/build.gradle`. */
function patchAppGradle(android, { versionName, versionCode }) {
  const file = join(android, 'app/build.gradle');
  let text = readFileSync(file, 'utf8');
  text = replaceRequired(text, /namespace\s*(?:=\s*)?(['"])[^'"]*\1/, `namespace = "${APP_ID}"`, 'namespace');
  text = replaceRequired(text, /applicationId\s+(['"])[^'"]*\1/, `applicationId "${APP_ID}"`, 'applicationId');
  text = replaceRequired(text, /versionCode\s+\d+/, `versionCode ${versionCode}`, 'versionCode');
  text = replaceRequired(text, /versionName\s+(['"])[^'"]*\1/, `versionName "${versionName}"`, 'versionName');
  writeFileSync(file, text);
}

/** Cleartext LAN traffic, resize-on-keyboard and the native permissions the mobile features need. */
function patchAndroidManifest(android) {
  const file = join(android, 'app/src/main/AndroidManifest.xml');
  let text = readFileSync(file, 'utf8');
  text = replaceRequired(text, /android:label=(["'])[^"']*\1/, `android:label="@string/app_name"`, 'application label');

  text = text.replace(/\s+android:usesCleartextTraffic=(["'])[^"']*\1/g, '');
  text = replaceRequired(
    text,
    /<application\b/,
    '<application\n        android:usesCleartextTraffic="true"',
    'usesCleartextTraffic',
  );

  text = text.replace(/\s+android:windowSoftInputMode=(["'])[^"']*\1/g, '');
  text = replaceRequired(
    text,
    /<activity\b/,
    '<activity\n            android:windowSoftInputMode="adjustResize"',
    'windowSoftInputMode',
  );

  const declared = new Set([...text.matchAll(/<uses-permission[^>]*android:name=(["'])([^"']+)\1/g)].map(match => match[2]));
  const missing = ANDROID_PERMISSIONS.filter(permission => !declared.has(permission));
  if (missing.length > 0) {
    const block = `${missing.map(permission => `    <uses-permission android:name="${permission}" />`).join('\n')}\n`;
    if (/<\/manifest>\s*$/.test(text)) text = text.replace(/<\/manifest>\s*$/, `${block}</manifest>\n`);
    else text = `${text.trimEnd()}\n${block}`;
  }
  writeFileSync(file, text);
}

/** The real Deep Student icon, replacing Capacitor's default placeholder in every generated density. */
function copyAppIcon(mobile, android) {
  const icon = join(mobile, '../public/app-icon.png');
  if (!existsSync(icon)) throw new Error(`build-apk: official app icon not found at ${icon}`);
  const res = join(android, 'app/src/main/res');
  if (!existsSync(res)) throw new Error(`build-apk: Android resources not found at ${res}`);
  let copied = 0;
  for (const entry of readdirSync(res)) {
    if (!entry.startsWith('mipmap-') || entry.startsWith('mipmap-anydpi')) continue;
    const dir = join(res, entry);
    for (const name of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
      const target = join(dir, name);
      if (existsSync(target)) {
        copyFileSync(icon, target);
        copied += 1;
      }
    }
  }
  if (copied === 0) throw new Error('build-apk: no mipmap-* icon targets found in the generated Android project');
  console.log(`App icon copied to ${copied} launcher assets (${APP_NAME})`);
}

/** Capacitor regenerates `android/`; apply our identity, manifest and icon changes after every sync. */
function patchAndroidProject(mobile, android, appVersion) {
  patchAppGradle(android, appVersion);
  patchAndroidManifest(android);
  // Capacitor's default back handling bypasses the frontend's dialog/navigation coordinator.
  const activity = join(android, 'app/src/main/java', ...APP_ID.split('.'), 'MainActivity.java');
  mkdirSync(dirname(activity), { recursive: true });
  writeFileSync(activity, `package ${APP_ID};

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                getBridge().getWebView().evaluateJavascript(
                    "Boolean(window.__DEEP_STUDENT_HANDLE_BACK__?.())",
                    handled -> {
                        if ("false".equals(handled)) moveTaskToBack(true);
                    }
                );
            }
        });
    }
}
`);
  copyAppIcon(mobile, android);
  const strings = join(android, 'app/src/main/res/values/strings.xml');
  if (existsSync(strings)) {
    const text = readFileSync(strings, 'utf8');
    writeFileSync(strings, replaceRequired(text, /<string name="app_name">[^<]*<\/string>/, `<string name="app_name">${APP_NAME}</string>`, 'app_name'));
  }
}

const javaHome = detectJava();
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT
  ?? (process.platform === 'darwin' ? join(homedir(), 'Library/Android/sdk') : join(homedir(), 'Android/Sdk'));
if (!existsSync(join(sdk, 'platforms/android-36'))) throw new Error(`Android SDK platform 36 is required at ${sdk}; set ANDROID_HOME.`);
const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk, PATH: `${join(javaHome, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` };
let restoreCapacitor;
try {
  console.log(`Building with JDK ${javaVersion(javaHome)}: ${javaHome}`);
  const appVersion = resolveAndroidAppVersion();
  run(process.execPath, [join(mobile, '../scripts/generate-version.mjs')], mobile, env);
  run(npm, ['run', 'build'], mobile, env);
  run(npx, ['cap', existsSync(android) ? 'sync' : 'add', 'android'], mobile, env);
  patchAndroidProject(mobile, android, appVersion);
  writeFileSync(join(android, 'local.properties'), `sdk.dir=${property(sdk)}\n`);

  const cached = cachedGradleZip();
  if (cached) {
    const wrapper = join(android, 'gradle/wrapper/gradle-wrapper.properties');
    writeFileSync(wrapper, readFileSync(wrapper, 'utf8').replace(/^distributionUrl=.*$/m, () => `distributionUrl=${property(pathToFileURL(cached).href)}`));
    console.log(`Using cached Gradle distribution: ${cached}`);
  }

  if (javaVersion(javaHome) === 17) {
    const capacitorGradle = join(mobile, 'node_modules/@capacitor/android/capacitor/build.gradle');
    const original = readFileSync(capacitorGradle);
    restoreCapacitor = () => writeFileSync(capacitorGradle, original);
    for (const file of [
      join(android, 'app/build.gradle'),
      join(android, 'app/capacitor.build.gradle'),
      join(android, 'capacitor-cordova-android-plugins/build.gradle'),
      capacitorGradle,
    ]) writeFileSync(file, readFileSync(file, 'utf8').replaceAll('VERSION_21', 'VERSION_17'));
  }

  run(process.platform === 'win32' ? join(android, 'gradlew.bat') : './gradlew', [release ? 'assembleRelease' : 'assembleDebug', '--console=plain'], android, env);
  if (!release) {
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(join(android, 'app/build/outputs/apk/debug/app-debug.apk'), output);
  } else {
    // No signingConfig in build.gradle, so Gradle leaves the release APK unsigned for us to align and sign.
    const unsigned = join(android, 'app/build/outputs/apk/release/app-release-unsigned.apk');
    if (!existsSync(unsigned)) throw new Error(`build-apk: expected an unsigned release APK at ${unsigned}`);
    signReleaseApk(sdk, unsigned, output, env);
  }
  console.log(`APK: ${output}`);
} finally {
  // Capacitor is an installed dependency, not our source. Restore its exact bytes even when Gradle fails.
  restoreCapacitor?.();
  if (cleanAndroid && existsSync(android)) rmSync(android, { recursive: true });
}
