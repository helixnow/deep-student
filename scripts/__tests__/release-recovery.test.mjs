import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { checkpoint, reusableReceipt, STAGES } from '../ci/release-recovery.mjs';
import { nativeIdentity, bundleWithRetry, executionCommand } from '../ci/native-build.mjs';
import { executableFromMessages } from '../ci/test-binary.mjs';
import { patchBuildTask } from '../ci/prepare-android-gradle.mjs';

const env = { RELEASE_SOURCE_SHA: 'a'.repeat(40), RELEASE_WORKFLOW_SHA: 'b'.repeat(40), RELEASE_POLICY: 'false', RELEASE_FRONTEND_SHA: 'f'.repeat(64) };
test('Windows bundling passes JSON argv directly to Node without a cmd or WSL shell', () => {
  const args = ['--no-install', 'tauri', 'bundle', '--config', '{"build":{"beforeBuildCommand":""}}'];
  const [program, argv] = executionCommand(args, 'win32', 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(program, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(argv[0], 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js');
  assert.deepEqual(argv.slice(1), args);
});
test('bundle retry is bounded, retries packaging only, and preserves the final failure', async () => {
  let calls = 0; let cleans = 0; const delays = [];
  assert.equal(await bundleWithRetry(() => ++calls === 2 ? 0 : 17, () => cleans++, async (ms) => delays.push(ms)), 0);
  assert.equal(calls, 2); assert.equal(cleans, 1); assert.deepEqual(delays, [15000]);
  calls = 0;
  assert.equal(await bundleWithRetry(() => { calls++; return 23; }, () => {}, async () => {}), 23);
  assert.equal(calls, 3);
});
test('recovery accepts successful stage outputs despite unrelated platform failures', () => {
  const expected = checkpoint('linux', env);
  const assets = STAGES.linux.map((name) => ({ name, expired: false }));
  assert.equal(reusableReceipt(expected, expected, assets), true);
  assert.equal(reusableReceipt(expected, expected, assets.slice(0, 1)), false);
  assert.equal(reusableReceipt(expected, expected, assets.map((a) => ({ ...a, expired: true }))), false);
  for (const key of ['sourceSha', 'workflowSha', 'policy', 'stage', 'schema', 'frontendSha256']) {
    assert.equal(reusableReceipt({ ...expected, [key]: 'different' }, expected, assets), false, key);
  }
  assert.throws(() => checkpoint('unknown', env));
});
test('native checkpoints distinguish frontend bytes, compiler flags and source revision', () => {
  const baseline = nativeIdentity('x86_64-unknown-linux-gnu', env, 'dist-one');
  assert.notDeepEqual(baseline, nativeIdentity('x86_64-unknown-linux-gnu', env, 'dist-two'));
  assert.notDeepEqual(baseline, nativeIdentity('x86_64-unknown-linux-gnu', { ...env, RUSTFLAGS: '-C opt-level=0' }, 'dist-one'));
  assert.notDeepEqual(baseline, nativeIdentity('x86_64-unknown-linux-gnu', { ...env, RELEASE_SOURCE_SHA: 'c'.repeat(40) }, 'dist-one'));
});
test('test executable selection ignores build scripts, dependencies, and stale non-test outputs', () => {
  const messages = [
    { reason: 'build-script-executed' },
    { reason: 'compiler-artifact', target: { name: 'fixture' }, profile: { test: false }, executable: '/wrong' },
    { reason: 'compiler-artifact', target: { name: 'fixture' }, profile: { test: true }, executable: '/exact-test' },
  ];
  assert.equal(executableFromMessages(messages.map(JSON.stringify).join('\n'), 'fixture'), '/exact-test');
  assert.throws(() => executableFromMessages('', 'fixture'));
  assert.throws(() => executableFromMessages([messages[2], messages[2]].map(JSON.stringify).join('\n'), 'fixture'));
});
test('Android generated-task patch is idempotent, rejects template drift and preserves normal builds', () => {
  const original = 'open class BuildTask { fun assemble() { runTauriCli("npm") } }';
  const patched = patchBuildTask(original);
  assert.equal(patchBuildTask(patched), patched);
  assert.ok(patched.indexOf('DS_ANDROID_PREBUILT_NATIVE') < patched.indexOf('runTauriCli'));
  assert.match(patched, /target != "aarch64" \|\| release != true/);
  assert.match(patched, /jni.canonicalFile != lib.canonicalFile/);
  assert.match(patched, /llvm-readelf/);
  assert.match(patched, /Java_app_tauri_plugin_PluginManager_handlePluginResponse/);
  assert.throws(() => patchBuildTask('new template'), /unsupported generated/);
});
test('fixture upgrade and fault execute the supplied binary without starting Cargo', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fixture-exec-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'fixture');
  writeFileSync(binary, '#!/bin/sh\necho "$MIGRATION_GATE_MODE" >> "$EXEC_LOG"\necho "test result: ok. 1 passed; 0 failed;"\n', { mode: 0o755 });
  for (const mode of ['upgrade', 'fault']) {
    const result = spawnSync('bash', ['scripts/migration-ci/run-fixture-upgrades.sh', '--fixture-root', root, '--mode', mode], {
      encoding: 'utf8', env: { ...process.env, MIGRATION_GATE_BINARY: binary, EXEC_LOG: path.join(root, 'executed') },
    });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(readFileSync(path.join(root, 'executed'), 'utf8'), 'upgrade\nfault\n');
});
test('native compile emits a recovery manifest before any bundling command', { skip: process.platform === 'win32' }, (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'bin'));
  const target = 'x86_64-unknown-linux-gnu';
  writeFileSync(path.join(root, 'bin/npx'), '#!/bin/sh\nprintf "%s\\n" "$@" > invoked\nmkdir -p src-tauri/target/x86_64-unknown-linux-gnu/release\nprintf binary > src-tauri/target/x86_64-unknown-linux-gnu/release/deep-student\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.resolve('scripts/ci/native-build.mjs'), 'compile', target], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env, GH_TOKEN: '', PATH: `${root}/bin:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(path.join(root, 'invoked'), 'utf8'), /--no-bundle/);
  const saved = JSON.parse(readFileSync(path.join(root, `src-tauri/target/${target}/release/native-build.json`)));
  assert.equal(saved.sourceSha, env.RELEASE_SOURCE_SHA);
  assert.equal(saved.target, target);
});

test('recovery CLI selects only complete matching stages and restores their exact artifact set', { skip: process.platform === 'win32' }, (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'release-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'bin'));
  const linux = checkpoint('linux', { ...env, RELEASE_POLICY: '' });
  const frontend = checkpoint('frontend', { ...env, RELEASE_POLICY: '' });
  const windows = checkpoint('windows', { ...env, RELEASE_SOURCE_SHA: 'c'.repeat(40), RELEASE_POLICY: 'true' });
  const run = { id: 12, path: '.github/workflows/rebuild-release.yml', event: 'workflow_dispatch', status: 'completed', head_sha: env.RELEASE_WORKFLOW_SHA };
  const artifacts = ['release-complete-frontend', 'frontend-dist', 'release-complete-linux', 'release-complete-windows', ...STAGES.linux, ...STAGES.windows].map((name) => ({ name, expired: false }));
  writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({ run, artifacts, linux, windows, frontend }));
  writeFileSync(path.join(root, 'bin/gh'), `#!/usr/bin/env node
const fs=require('fs'), path=require('path'); const f=JSON.parse(fs.readFileSync(process.env.GH_FIXTURE)); const a=process.argv.slice(2);
if(a[0]==='api') {const e=a[1]; console.log(JSON.stringify(e.includes('/artifacts?')?{artifacts:f.artifacts}:e.includes('/workflows/')?{workflow_runs:[f.run]}:f.run));}
else {const name=a[a.indexOf('--name')+1],dir=a[a.indexOf('--dir')+1];fs.mkdirSync(dir,{recursive:true});fs.appendFileSync(process.env.GH_CALLS,name+'\\n');if(name.startsWith('release-complete-'))fs.writeFileSync(path.join(dir,'checkpoint.json'),JSON.stringify(f[name.replace('release-complete-','')]));else fs.writeFileSync(path.join(dir,'asset'),name);}
`, { mode: 0o755 });
  const cli = path.resolve('scripts/ci/release-recovery.mjs');
  const e = { ...process.env, ...env, RELEASE_POLICY: '', GITHUB_REPOSITORY: 'test/repo', GITHUB_RUN_ID: '20',
    GITHUB_OUTPUT: path.join(root, 'outputs'), GITHUB_STEP_SUMMARY: path.join(root, 'summary'),
    GH_FIXTURE: path.join(root, 'fixture.json'), GH_CALLS: path.join(root, 'calls'), PATH: `${root}/bin:${process.env.PATH}` };
  let r = spawnSync(process.execPath, [cli, 'plan'], { cwd: root, env: e, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const output = readFileSync(e.GITHUB_OUTPUT, 'utf8');
  assert.match(output, /^linux=12$/m); assert.match(output, /^windows=$/m);
  r = spawnSync(process.execPath, [cli, 'restore', 'linux', '12'], { cwd: root, env: e, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const artifact of STAGES.linux) assert.equal(readFileSync(path.join(root, 'recovered/linux', artifact, 'asset'), 'utf8'), artifact);
  r = spawnSync(process.execPath, [cli, 'plan'], { cwd: root, env: { ...e, RESUME_RUN_ID: '12', RELEASE_SOURCE_SHA: 'd'.repeat(40) }, encoding: 'utf8' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /refusing an accidental full rebuild/);
  const before = readFileSync(e.GH_CALLS, 'utf8');
  r = spawnSync(process.execPath, [cli, 'plan'], { cwd: root, env: { ...e, FORCE_REBUILD: 'true' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(e.GH_CALLS, 'utf8'), before, 'forced rebuild must not download old checkpoints');
});

test('an unavailable compiler cache clears the wrapper while a healthy cache is retained', { skip: process.platform === 'win32' }, (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cache-fallback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['sccache', 'sleep']) {
    writeFileSync(path.join(root, name), name === 'sccache' ? '#!/bin/sh\nexit "$CACHE_EXIT"\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  for (const code of ['0', '1']) {
    const output = path.join(root, `env-${code}`);
    const r = spawnSync('bash', ['scripts/ci/prepare-sccache.sh'], { encoding: 'utf8', env: {
      ...process.env, PATH: `${root}:${process.env.PATH}`, CACHE_EXIT: code, GITHUB_ENV: output,
    } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(output, 'utf8'), code === '0' ? 'RUSTC_WRAPPER=sccache\n' : 'RUSTC_WRAPPER=\n');
  }
});
