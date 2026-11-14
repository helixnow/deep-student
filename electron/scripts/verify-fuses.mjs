#!/usr/bin/env node
/**
 * 打包产物的 fuse、asar 完整性与签名校验。
 *
 *   node electron/scripts/verify-fuses.mjs [--mac] [--app "<path>/Deep Student.app"] [--static]
 *   node electron/scripts/verify-fuses.mjs --win|--linux [--unpacked release/win-unpacked]
 *
 * `--win` / `--linux` 只做静态校验（任何主机）：fuse wire 与 expectedFuses(平台) 一致、只有 app.asar、原生二进制
 * 解包；Windows 另查 exe 资源里的 asar 完整性清单（win-asar-integrity.mjs）。Linux 上 Electron 不做 asar 完整性校验。
 * 以下为 macOS `.app`：
 *
 * 静态：主程序 fuse wire 与 scripts/app-hardening.cjs 的 expectedFuses('darwin', 签名方式) 一致（签名方式从
 * codesign 读出：ad-hoc 或正式签名）；Info.plist 的 `ElectronAsarIntegrity` 等于 app.asar 头部的 SHA256；只有
 * app.asar（无 Resources/app、无 default_app.asar）；原生二进制全部解包；签名完整；主程序与全部 helper 开启
 * hardened runtime，entitlements 与 electron/signing/ 下对应文件一致；麦克风用途说明与 Tauri 版相同。
 * 行为（每项在隔离数据目录、必要时在 APFS 克隆副本上启动真实产物）：
 * - `ELECTRON_RUN_AS_NODE=1 <exe> -e …` 不会以 Node 执行脚本；
 * - `--inspect` 不会开启 Node 调试端口；
 * - 改动 app.asar 头部一个字节后应用拒绝启动；
 * - 去掉 app.asar、放一个 Resources/app/ 目录，应用不会加载它；
 * - `DYLD_INSERT_LIBRARIES` 注入的 dylib 不会被加载（同一探针在未加固的对照程序里会加载；需要 `cc`）。
 * EnableNodeOptionsEnvironmentVariable、EnableCookieEncryption、GrantFileProtocolExtraPrivileges 只做静态校验：
 * 打包应用里 Electron 本就只接受 NODE_OPTIONS 中的 `--max-http-header-size` / `--http-parser`，`--require`
 * 探针在 fuse 开关两种状态下都不执行，区分不了；后两者没有可从外部观察的启动行为。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync, openSync, readSync, writeSync, closeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { defaultSourceApp, isolatedEnv, prepareApp, repoRoot, workBase } from './packaged-app.mjs';
import { readWinAsarIntegrity } from './win-asar-integrity.mjs';

const require = createRequire(import.meta.url);
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
const asar = require('@electron/asar');
const plist = require('plist');
const { expectedFuses, macSigning } = require('./app-hardening.cjs');

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
const staticOnly = argv.includes('--static');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 启动产物，`settleMs` 内观察；返回是否自行退出、输出。结束时杀掉整个进程组。 */
async function observe(executable, { root, args = [], env = {}, settleMs = 12_000 }) {
  const child = spawn(executable, args, { cwd: root, env: isolatedEnv(root, env), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = '';
  child.stdout.on('data', (c) => { output += c.toString(); });
  child.stderr.on('data', (c) => { output += c.toString(); });
  let exit = null;
  const exited = new Promise((r) => child.on('exit', (code, signal) => { exit = { code, signal }; r(); }));
  await Promise.race([exited, sleep(settleMs)]);
  if (exit === null) {
    killGroup(child.pid);
    await Promise.race([exited, sleep(5_000)]);
    return { selfExited: false, exit, output };
  }
  killGroup(child.pid);
  return { selfExited: true, exit, output };
}

/** SIGKILL 整个进程组（主进程与 helper）；进程组已全部退出（ESRCH）时返回 false，其他错误照常抛出。 */
function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

/** APFS 克隆（`cp -c`），改动不影响原产物。 */
function cloneApp(appPath, dir) {
  const target = join(dir, 'clone.app');
  execFileSync('cp', ['-cR', appPath, target]);
  return { appPath: target, contentsDir: join(target, 'Contents'), executable: join(target, 'Contents', 'MacOS', execFileSync('defaults', ['read', join(target, 'Contents', 'Info.plist'), 'CFBundleExecutable'], { encoding: 'utf8' }).trim()) };
}

/** `codesign -dv` 的描述（codesign 写在 stderr）。 */
const codesignInfo = (path) => spawnSync('codesign', ['-dv', '--verbose=4', path], { encoding: 'utf8' }).stderr;

function entitlementsOf(path) {
  const xml = execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return xml === '' ? {} : plist.parse(xml);
}

/** 主程序与 `Contents/Frameworks/*.app` 下各 helper（Renderer、GPU、Plugin…，Host 的 utilityProcess 也在其中）的可执行文件。 */
function signedExecutables({ contentsDir, executable }) {
  const frameworks = join(contentsDir, 'Frameworks');
  const helpers = readdirSync(frameworks).filter((name) => name.endsWith('.app'))
    .map((name) => join(frameworks, name, 'Contents', 'MacOS', basename(name, '.app')));
  return [executable, ...helpers];
}

async function staticChecks(app) {
  const { appPath, contentsDir, executable } = app;
  const signed = !/^Signature=adhoc$/m.test(codesignInfo(appPath));
  const mode = signed ? 'release signed' : 'ad hoc';
  {
    const wire = await getCurrentFuseWire(executable);
    const expected = expectedFuses('darwin', { signed });
    const actual = Object.fromEntries(Object.keys(expected).map((name) => [name, wire[FuseV1Options[name]] === 49 ? true : wire[FuseV1Options[name]] === 48 ? false : `state ${wire[FuseV1Options[name]]}`]));
    check(`fuses: wire matches expectedFuses(darwin, ${mode})`, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual));

  }
  const resources = join(contentsDir, 'Resources');
  const archive = join(resources, 'app.asar');
  check('layout: app.asar only (no Resources/app, no default_app.asar)', existsSync(archive) && !existsSync(join(resources, 'app')) && !existsSync(join(resources, 'default_app.asar')));
  const info = plist.parse(readFileSync(join(contentsDir, 'Info.plist'), 'utf8'));
  const tauriInfo = plist.parse(readFileSync(join(repoRoot, 'resources/app', 'Info.plist'), 'utf8'));
  check('Info.plist: microphone usage description matches the Tauri app', info.NSMicrophoneUsageDescription === tauriInfo.NSMicrophoneUsageDescription, info.NSMicrophoneUsageDescription);
  if (existsSync(archive)) {
    const header = createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex');
    const recorded = info.ElectronAsarIntegrity?.['Resources/app.asar'];
    check('integrity: Info.plist ElectronAsarIntegrity = SHA256(app.asar header)', recorded?.algorithm === 'SHA256' && recorded.hash === header, `${recorded?.hash ?? 'missing'} vs ${header}`);
    const listed = asar.listPackage(archive, { isPack: true });
    const packedNatives = listed.filter((line) => line.startsWith('pack') && /\.(node|dylib|so|dll|exe)$|\.so\.\d/.test(line));
    const unpackedNatives = listed.filter((line) => line.startsWith('unpack') && /\.node$/.test(line));
    check('asar: native binaries unpacked, none inside the archive', packedNatives.length === 0 && unpackedNatives.length > 0, `${unpackedNatives.length} .node unpacked${packedNatives.length ? `; packed: ${packedNatives.slice(0, 3).join(', ')}` : ''}`);
  }
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
    check(`signature: ${mode} signature valid after flipping fuses`, true);
  } catch (error) {
    check(`signature: ${mode} signature valid after flipping fuses`, false, String(error.stderr ?? error.message).trim().slice(0, 300));
  }
  const executables = signedExecutables(app);
  const notHardened = executables.filter((file) => !/^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/m.test(codesignInfo(file)));
  check('signature: hardened runtime on the main executable and every helper', executables.length > 1 && notHardened.length === 0,
    `${executables.length} executables${notHardened.length ? `; without runtime: ${notHardened.map((f) => basename(f)).join(', ')}` : ''}`);
  const expectedEntitlements = plist.parse(readFileSync(macSigning(signed ? { CSC_NAME: 'release' } : {}, repoRoot).mac.entitlements, 'utf8'));
  const mismatched = executables.filter((file) => !isDeepStrictEqual(entitlementsOf(file), expectedEntitlements));
  check(`signature: entitlements match electron/signing (${mode})`, mismatched.length === 0,
    mismatched.length ? `${mismatched.map((f) => `${basename(f)} ${JSON.stringify(entitlementsOf(f))}`).join('; ')}` : Object.keys(expectedEntitlements).join(', '));
}

/** `DYLD_INSERT_LIBRARIES` 探针：构造函数把加载它的进程路径写进 `$DS_DYLD_PROBE_MARKER`。 */
function buildDyldProbe(dir) {
  const source = join(dir, 'probe.c');
  writeFileSync(source, [
    '#include <stdio.h>', '#include <stdlib.h>',
    '__attribute__((constructor)) static void probe(void) {',
    '  const char *marker = getenv("DS_DYLD_PROBE_MARKER");',
    '  if (marker == NULL) return;',
    '  FILE *f = fopen(marker, "a");',
    '  if (f != NULL) { fputs("loaded\\n", f); fclose(f); }',
    '}', '',
  ].join('\n'));
  const dylib = join(dir, 'probe.dylib');
  execFileSync('cc', ['-dynamiclib', '-o', dylib, source], { stdio: 'pipe' });
  const control = join(dir, 'control');
  writeFileSync(join(dir, 'control.c'), 'int main(void) { return 0; }\n');
  execFileSync('cc', ['-o', control, join(dir, 'control.c')], { stdio: 'pipe' });
  return { dylib, control };
}

async function behaviourChecks(app) {
  const base = mkdtempSync(join(workBase(), 'fuses-'));
  const marker = (root) => join(root, 'probe-ran');
  try {
    {
      const root = join(base, 'run-as-node');
      mkdirSync(root, { recursive: true });
      const r = await observe(app.executable, { root, env: { ELECTRON_RUN_AS_NODE: '1', PROBE: marker(root) }, args: ['-e', "require('fs').writeFileSync(process.env.PROBE, 'x')"] });
      check('RunAsNode off: ELECTRON_RUN_AS_NODE=1 does not run a Node script', !existsSync(marker(root)), r.selfExited ? `exited ${JSON.stringify(r.exit)}` : 'started as the app');
    }
    {
      const root = join(base, 'inspect');
      mkdirSync(root, { recursive: true });
      const r = await observe(app.executable, { root, args: ['--inspect=127.0.0.1:0', '--inspect-brk-node=127.0.0.1:0'] });
      check('NodeCliInspect off: --inspect opens no debugger', !/Debugger listening/i.test(r.output), r.output.match(/Debugger listening[^\n]*/i)?.[0] ?? '');
    }
    {
      const root = join(base, 'tampered');
      mkdirSync(root, { recursive: true });
      const clone = cloneApp(app.appPath, root);
      const archive = join(clone.contentsDir, 'Resources', 'app.asar');
      // 头部 JSON 里第一个 `"hash":"<hex>"` 的首位十六进制字符换掉：JSON 仍合法，头部哈希变了。
      const fd = openSync(archive, 'r+');
      const head = Buffer.alloc(64 * 1024);
      readSync(fd, head, 0, head.length, 0);
      const at = head.indexOf('"hash":"') + '"hash":"'.length;
      const replacement = head[at] === 0x30 ? '1' : '0';
      writeSync(fd, replacement, at);
      closeSync(fd);
      const r = await observe(clone.executable, { root, args: ['--remote-debugging-port=0'], settleMs: 20_000 });
      const started = /DevTools listening/.test(r.output);
      check('AsarIntegrity on: a modified app.asar header is refused at startup', r.selfExited && !started,
        `${r.selfExited ? `exited ${JSON.stringify(r.exit)}` : 'still running'}; ${(r.output.match(/[^\n]*integrity[^\n]*/i)?.[0] ?? '').trim().slice(0, 200)}`);
    }
    {
      const root = join(base, 'loose-app');
      mkdirSync(root, { recursive: true });
      const clone = cloneApp(app.appPath, root);
      const resources = join(clone.contentsDir, 'Resources');
      renameSync(join(resources, 'app.asar'), join(root, 'app.asar.moved'));
      mkdirSync(join(resources, 'app'), { recursive: true });
      writeFileSync(join(resources, 'app', 'package.json'), JSON.stringify({ name: 'loose', main: 'main.js' }));
      writeFileSync(join(resources, 'app', 'main.js'), `require('fs').writeFileSync(${JSON.stringify(marker(root))}, 'x'); require('electron').app.quit();\n`);
      await observe(clone.executable, { root });
      check('OnlyLoadAppFromAsar on: a loose Resources/app directory is never loaded', !existsSync(marker(root)));
    }
    {
      const root = join(base, 'dyld-insert');
      mkdirSync(root, { recursive: true });
      let probe = null;
      try {
        probe = buildDyldProbe(root);
      } catch (error) {
        check('hardened runtime: DYLD_INSERT_LIBRARIES is ignored', false, `cannot build the probe dylib with cc: ${String(error.stderr ?? error.message).trim().slice(0, 200)}`);
      }
      if (probe !== null) {
        const controlMarker = join(root, 'control-loaded');
        spawnSync(probe.control, [], { env: { ...process.env, DYLD_INSERT_LIBRARIES: probe.dylib, DS_DYLD_PROBE_MARKER: controlMarker } });
        const r = await observe(app.executable, { root, env: { DYLD_INSERT_LIBRARIES: probe.dylib, DS_DYLD_PROBE_MARKER: marker(root) } });
        check('hardened runtime: DYLD_INSERT_LIBRARIES is ignored', existsSync(controlMarker) && !existsSync(marker(root)),
          `control program ${existsSync(controlMarker) ? 'loaded the probe' : 'did NOT load the probe (inconclusive)'}; app ${existsSync(marker(root)) ? 'LOADED it' : 'did not'}${r.selfExited ? `, exited ${JSON.stringify(r.exit)}` : ''}`);
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** Windows / Linux 解包目录的静态校验（任何主机都能跑：fuse wire 与 exe 资源都按字节读取）。 */
async function unpackedStaticChecks(dir, platform) {
  const config = require('../electron-builder.config.cjs');
  const executable = join(dir, platform === 'win32' ? `${config.productName}.exe` : JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).name);
  if (!existsSync(executable)) throw new Error(`no ${platform} executable at ${executable}: run \`node electron/scripts/package.mjs --${platform === 'win32' ? 'win' : 'linux'} --dir\` first`);
  const wire = await getCurrentFuseWire(executable);
  const expected = expectedFuses(platform);
  const actual = Object.fromEntries(Object.keys(expected).map((name) => [name, wire[FuseV1Options[name]] === 49 ? true : wire[FuseV1Options[name]] === 48 ? false : `state ${wire[FuseV1Options[name]]}`]));
  check(`fuses: wire matches expectedFuses(${platform})`, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual));
  const resources = join(dir, 'resources');
  const archive = join(resources, 'app.asar');
  check('layout: app.asar only (no resources/app, no default_app.asar)', existsSync(archive) && !existsSync(join(resources, 'app')) && !existsSync(join(resources, 'default_app.asar')));
  if (!existsSync(archive)) return;
  const header = createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex');
  if (platform === 'win32') {
    const integrity = readWinAsarIntegrity(readFileSync(executable));
    check('integrity: exe resource INTEGRITY/ELECTRONASAR = SHA256(app.asar header)',
      JSON.stringify(integrity) === JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: header }]), `${JSON.stringify(integrity)} vs ${header}`);
  }
  const listed = asar.listPackage(archive, { isPack: true });
  const packedNatives = listed.filter((line) => line.startsWith('pack') && /\.(node|dylib|so|dll|exe)$|\.so\.\d/.test(line));
  const unpackedNatives = listed.filter((line) => line.startsWith('unpack') && /\.node$/.test(line));
  check('asar: native binaries unpacked, none inside the archive', packedNatives.length === 0 && unpackedNatives.length > 0, `${unpackedNatives.length} .node unpacked${packedNatives.length ? `; packed: ${packedNatives.slice(0, 3).join(', ')}` : ''}`);
}

async function main() {
  const target = argv.includes('--win') ? 'win32' : argv.includes('--linux') ? 'linux' : 'darwin'; // `--mac` 与默认同为 darwin
  if (target !== 'darwin') {
    const dir = resolve(opt('--unpacked') ?? join(repoRoot, 'release', target === 'win32' ? 'win-unpacked' : 'linux-unpacked'));
    console.log(`unpacked: ${dir}`);
    await unpackedStaticChecks(dir, target);
    console.log(`NOT RUN: behaviour checks (RunAsNode, --inspect, modified app.asar refused${target === 'win32' ? '' : ' — Linux has no asar integrity'}, loose resources/app) are automated for the macOS .app only`);
  } else {
    if (process.platform !== 'darwin') throw new Error('the macOS .app checks need a macOS host (codesign, APFS clones)');
    const app = prepareApp(resolve(opt('--app') ?? defaultSourceApp()));
    console.log(`app: ${app.appPath}`);
    await staticChecks(app);
    if (!staticOnly) await behaviourChecks(app);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`verify-fuses failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
