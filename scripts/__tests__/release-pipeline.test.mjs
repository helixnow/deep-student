import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyMetadata, cargoRootVersion, writeFrontend, verifyFrontend, FRONTEND_MANIFEST,
  writeProvenance, verifyArtifacts, TARGETS, assetInventory, checkSecrets, verifyTag, pointerDecision, patchAndroidManifest,
} from '../ci/release-contracts.mjs';
import { selectCiRun, waitForCi } from '../ci/release-ci-gate.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readProject = (file) => readFileSync(path.join(project, file), 'utf8');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const workflowSha = 'c'.repeat(40);
const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function put(root, file, value) {
  const name = path.join(root, file); mkdirSync(path.dirname(name), { recursive: true });
  writeFileSync(name, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
function notices(root) {
  const npm = JSON.parse(readFileSync(path.join(root, 'package-lock.json')));
  delete npm.version; delete npm.packages[''].version;
  put(root, 'legal/THIRD_PARTY_NOTICES.txt', `Cargo.lock SHA256: ${sha(readFileSync(path.join(root, 'src-tauri/Cargo.lock')))}\npackage-lock.json SHA256: ${sha(JSON.stringify(npm))}\n`);
}
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'release-contract-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'work'); mkdirSync(root);
  put(root, 'package.json', { name: 'deep-student', version: '1.2.3' });
  put(root, 'package-lock.json', { name: 'deep-student', version: '1.2.3', lockfileVersion: 3, packages: { '': { name: 'deep-student', version: '1.2.3' }, 'node_modules/example': { version: '2.0.0', license: 'MIT' } } });
  put(root, 'src-tauri/Cargo.toml', '[package]\nname = "deep-student"\nversion = "1.2.3"\n\n[lib]\nname = "deep_student_lib"\n');
  put(root, 'src-tauri/Cargo.lock', '# generated\nversion = 4\n\n[[package]]\nname = "deep-student"\nversion = "1.2.3"\ndependencies = ["example"]\n\n[[package]]\nname = "example"\nversion = "2.0.0"\nsource = "registry+https://example.invalid/index"\n');
  put(root, 'src-tauri/tauri.conf.json', { version: '1.2.3' });
  put(root, '.gitattributes', '* text=auto eol=lf\n');
  notices(root);
  git(root, 'init', '-q'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
  const sourceSha = git(root, 'rev-parse', 'HEAD');
  put(root, 'dist/index.html', '<html>verified frontend</html>');
  put(root, 'dist/assets/main.js', 'console.log("fixture");');
  return { root, dir, sourceSha };
}

test('release metadata validates all version declarations and lock hashes', (t) => {
  const f = fixture(t);
  assert.equal(verifyMetadata(f.root, '1.2.3').version, '1.2.3');
  assert.throws(() => verifyMetadata(f.root, '1.2.4'), /package.json version mismatch/);
});
for (const [label, file, alter, expected] of [
  ['stale Cargo root', 'src-tauri/Cargo.lock', (s) => s.replace('version = "1.2.3"', 'version = "1.2.2"'), /Cargo.lock root version mismatch/],
  ['stale notice digest', 'legal/THIRD_PARTY_NOTICES.txt', (s) => s.replace(/Cargo.lock SHA256: .+/, 'Cargo.lock SHA256: stale'), /license notices mismatch/],
  ['npm root version', 'package-lock.json', (s) => s.replace('"version": "1.2.3"', '"version": "1.2.2"'), /package-lock.json root version mismatch/],
  ['npm nested root version', 'package-lock.json', (s) => { const d = JSON.parse(s); d.packages[''].version = '1.2.2'; return JSON.stringify(d); }, /packages\[""\] version mismatch/],
  ['dependency metadata drift', 'src-tauri/Cargo.lock', (s) => s.replace('version = "2.0.0"', 'version = "2.1.0"'), /license notices mismatch/],
]) {
  test(`metadata rejects ${label}`, (t) => {
    const f = fixture(t); put(f.root, file, alter(readFileSync(path.join(f.root, file), 'utf8')));
    assert.throws(() => verifyMetadata(f.root), expected);
  });
}
test('Cargo root matching excludes registry packages and rejects ambiguity', () => {
  const root = '[[package]]\nname = "deep-student"\nversion = "1.2.3"\n';
  assert.equal(cargoRootVersion(`${root}\n[[package]]\nname = "deep-student"\nversion = "9.0.0"\nsource = "registry+example"\n`, 'deep-student'), '1.2.3');
  assert.throws(() => cargoRootVersion(root + root, 'deep-student'), /exactly one/);
  assert.throws(() => cargoRootVersion('', 'deep-student'), /exactly one/);
});
test('frontend provenance binds a SHA, workflow revision, lockfiles and exact bytes', async (t) => {
  const f = fixture(t); const dist = path.join(f.root, 'dist');
  await writeFrontend(f.root, f.sourceSha, workflowSha, dist);
  assert.match(await verifyFrontend(f.root, f.sourceSha, workflowSha, dist), /^[a-f0-9]{64}$/);
  await assert.rejects(verifyFrontend(f.root, f.sourceSha, 'd'.repeat(40), dist), /workflowSha/);
  put(f.root, 'dist/assets/main.js', 'tampered');
  await assert.rejects(verifyFrontend(f.root, f.sourceSha, workflowSha, dist), /content changed/);
});
test('same version from a different commit is not the same frontend', async (t) => {
  const f = fixture(t); const dist = path.join(f.root, 'dist');
  await writeFrontend(f.root, f.sourceSha, workflowSha, dist);
  put(f.root, 'new-source.txt', 'new code, same version');
  git(f.root, 'add', 'new-source.txt'); git(f.root, 'commit', '-qm', 'different source');
  await assert.rejects(verifyFrontend(f.root, git(f.root, 'rev-parse', 'HEAD'), workflowSha, dist), /sourceSha/);
});
test('provenance rejects a missing manifest and hidden-file changes', async (t) => {
  const f = fixture(t); const dist = path.join(f.root, 'dist');
  await assert.rejects(verifyFrontend(f.root, f.sourceSha, workflowSha, dist), /ENOENT/);
  put(f.root, 'dist/.hidden', 'one');
  await writeFrontend(f.root, f.sourceSha, workflowSha, dist);
  put(f.root, 'dist/.hidden', 'two');
  await assert.rejects(verifyFrontend(f.root, f.sourceSha, workflowSha, dist), /content changed/);
});
test('uncommitted lock regeneration cannot be passed off as the source commit', async (t) => {
  const f = fixture(t);
  const lock = readFileSync(path.join(f.root, 'src-tauri/Cargo.lock'), 'utf8');
  put(f.root, 'src-tauri/Cargo.lock', lock.replace('version = "2.0.0"', 'version = "2.1.0"'));
  notices(f.root); // internally consistent, but not the named source commit
  await assert.rejects(writeFrontend(f.root, f.sourceSha, workflowSha, path.join(f.root, 'dist')), /source was mutated/);
});
test('frontend symlinks are rejected rather than hashing paths outside the artifact', async (t) => {
  const f = fixture(t);
  symlinkSync(path.join(f.root, 'package.json'), path.join(f.root, 'dist/link.json'));
  await assert.rejects(writeFrontend(f.root, f.sourceSha, workflowSha, path.join(f.root, 'dist')), /symlink/);
});

async function releaseArtifacts(t, android = false) {
  const f = fixture(t); const artifacts = path.join(f.dir, 'artifacts'); mkdirSync(artifacts);
  await writeFrontend(f.root, f.sourceSha, workflowSha, path.join(f.root, 'dist'));
  for (const [target, rule] of Object.entries(TARGETS)) {
    if (target === 'aarch64-linux-android' && !android) continue;
    const output = path.join(f.dir, `bundle-${target}`); mkdirSync(output);
    const fileName = `Deep.Student_1.2.3${rule.suffixes[0]}`;
    put(output, `${rule.outputDirs[0]}/${fileName}`, `${target} installer`);
    // Real .app bundles contain symlinks; only uploaded archives/DMGs are inventoried.
    if (target.includes('apple')) {
      const app = path.join(output, 'macos/Fake.app'); mkdirSync(app, { recursive: true });
      symlinkSync('/nonexistent-fixture-library', path.join(app, 'library'));
    }
    const proofDir = path.join(artifacts, `release-provenance-${target}`);
    await writeProvenance(f.root, f.sourceSha, workflowSha, target, output, path.join(proofDir, 'release-provenance.json'));
    mkdirSync(path.join(artifacts, rule.artifact));
    cpSync(path.join(output, rule.outputDirs[0], fileName), path.join(artifacts, rule.artifact, fileName));
  }
  return { ...f, artifacts };
}
test('all four desktop targets validate without Android, or with a verified APK', async (t) => {
  const a = await releaseArtifacts(t, false); await verifyArtifacts(a.artifacts, a.sourceSha, workflowSha, '1.2.3');
  const b = await releaseArtifacts(t, true); await verifyArtifacts(b.artifacts, b.sourceSha, workflowSha, '1.2.3');
});
for (const [key, value] of [['sourceSha', 'a'.repeat(40)], ['workflowSha', 'a'.repeat(40)], ['version', '1.2.2'], ['target', 'wrong-target'], ['schemaVersion', 99], ['cargoLockSha256', 'd'.repeat(64)], ['frontendSha256', 'e'.repeat(64)]]) {
  test(`publication rejects mixed/tampered provenance field ${key}`, async (t) => {
    const f = await releaseArtifacts(t);
    const rel = 'release-provenance-x86_64-unknown-linux-gnu/release-provenance.json';
    const proof = JSON.parse(readFileSync(path.join(f.artifacts, rel))); proof[key] = value; put(f.artifacts, rel, proof);
    await assert.rejects(verifyArtifacts(f.artifacts, f.sourceSha, workflowSha, '1.2.3'));
  });
}
test('publication rejects changed binary bytes, missing desktop targets and unproven APKs', async (t) => {
  const f = await releaseArtifacts(t);
  put(f.artifacts, 'windows-x86_64/Deep.Student_1.2.3.exe', 'tampered');
  await assert.rejects(verifyArtifacts(f.artifacts, f.sourceSha, workflowSha, '1.2.3'), /bytes differ/);
  const g = await releaseArtifacts(t);
  rmSync(path.join(g.artifacts, 'linux-x86_64'), { recursive: true });
  await assert.rejects(verifyArtifacts(g.artifacts, g.sourceSha, workflowSha, '1.2.3'), /missing artifact/);
  const h = await releaseArtifacts(t); put(h.artifacts, 'android-arm64/unproven.apk', 'apk');
  await assert.rejects(verifyArtifacts(h.artifacts, h.sourceSha, workflowSha, '1.2.3'), /ENOENT/);
});
test('inventory rejects duplicate basenames and zero-byte files', async (t) => {
  const f = fixture(t); const dir = path.join(f.dir, 'assets');
  put(dir, 'a/test.exe', 'one'); put(dir, 'b/test.exe', 'two');
  await assert.rejects(assetInventory(dir, 'x86_64-pc-windows-msvc'), /ambiguous/);
  rmSync(path.join(dir, 'b'), { recursive: true }); put(dir, 'a/test.exe', '');
  await assert.rejects(assetInventory(dir, 'x86_64-pc-windows-msvc'), /empty release artifact/);
});
test('inventory rejects filenames that collide after publication normalization', async (t) => {
  const f = fixture(t); const dir = path.join(f.dir, 'assets');
  put(dir, 'App Setup.exe', 'one'); put(dir, 'App.Setup.exe', 'two');
  await assert.rejects(assetInventory(dir, 'x86_64-pc-windows-msvc'), /ambiguous/);
});
test('unsigned desktop policy does not disable updater or publication credentials', () => {
  const env = { ALLOW_UNSIGNED_DESKTOP: 'true', TAURI_SIGNING_PRIVATE_KEY: 'secret', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'secret', CLOUDFLARE_ACCOUNT_ID: 'secret', CLOUDFLARE_API_TOKEN: 'secret' };
  assert.doesNotThrow(() => checkSecrets(env)); // Android credentials deliberately optional here
  assert.throws(() => checkSecrets({ ...env, ALLOW_UNSIGNED_DESKTOP: 'false' }), /APPLE_CERTIFICATE_BASE64/);
  assert.throws(() => checkSecrets({ ...env, TAURI_SIGNING_PRIVATE_KEY: '' }), /TAURI_SIGNING_PRIVATE_KEY/);
});
test('Android supplement updates availability without dropping desktop signatures', () => {
  const manifest = { version: '1.2.3', platforms: { 'linux-x86_64': { url: 'https://example.invalid/app', signature: 'signed' } }, android: { status: 'failed-pending-rebuild' } };
  const updated = patchAndroidManifest(manifest, '1.2.3', 'https://example.invalid/app.apk');
  assert.equal(updated.android.status, 'available');
  assert.deepEqual(updated.platforms, manifest.platforms);
  assert.equal(manifest.android.status, 'failed-pending-rebuild');
  assert.throws(() => patchAndroidManifest(manifest, '1.2.4', 'https://example.invalid/app.apk'), /target version/);
  assert.throws(() => patchAndroidManifest(manifest, '1.2.3', 'http://example.invalid/app.apk'), /HTTPS/);
});
test('updater comparisons are numeric and cannot downgrade an existing channel', () => {
  assert.equal(pointerDecision('0.9.62', '0.9.61'), 'skip-older');
  assert.equal(pointerDecision('0.9.62', '0.9.62'), 'refresh');
  assert.equal(pointerDecision('0.9.9', '0.9.10'), 'advance');
  assert.equal(pointerDecision('1.0.0', '0.99.999'), 'skip-older');
  assert.throws(() => pointerDecision('', '0.9.62'));
  assert.throws(() => pointerDecision('bad response', '0.9.62'));
});
test('tag verification supports lightweight/annotated tags and rejects moved or absent tags', (t) => {
  const f = fixture(t); const remote = path.join(f.dir, 'origin.git');
  put(f.root, 'next.txt', 'new'); git(f.root, 'add', 'next.txt'); git(f.root, 'commit', '-qm', 'next');
  const next = git(f.root, 'rev-parse', 'HEAD');
  execFileSync('git', ['clone', '--bare', '--quiet', f.root, remote]);
  git(f.root, 'remote', 'add', 'origin', remote);
  git(remote, 'tag', 'v1.2.3', f.sourceSha);
  assert.doesNotThrow(() => verifyTag(f.root, 'v1.2.3', f.sourceSha));
  git(remote, 'tag', '-a', 'v1.2.4', '-m', 'annotated', f.sourceSha);
  assert.doesNotThrow(() => verifyTag(f.root, 'v1.2.4', f.sourceSha));
  git(remote, 'tag', '-f', 'v1.2.3', next);
  assert.throws(() => verifyTag(f.root, 'v1.2.3', f.sourceSha), /tag moved/);
  assert.throws(() => verifyTag(f.root, 'v9.9.9', f.sourceSha), /disappeared/);
});

const run = (overrides = {}) => ({ id: 1, head_sha: 'a'.repeat(40), event: 'push', created_at: '2026-09-19T00:00:00Z', status: 'completed', conclusion: 'success', run_attempt: 1, html_url: 'https://example.invalid/run/1', ...overrides });
function ciHarness(responses, overrides = {}) {
  let clock = 0; let index = 0;
  return { sourceSha: 'a'.repeat(40), repo: 'owner/repo', token: 'fixture-token', now: () => clock,
    sleep: async (ms) => { clock += ms; }, intervalMs: 10, missingGraceMs: 20, timeoutMs: 80, log: () => {},
    fetchImpl: async () => { const value = responses[Math.min(index++, responses.length - 1)]; if (value instanceof Error) throw value;
      return { status: value.status || 200, ok: !value.status || value.status === 200, json: async () => ({ workflow_runs: value.runs || [] }) }; }, ...overrides };
}
test('CI chooses the newest exact-SHA push, never a PR merge-ref or older green run', async () => {
  assert.equal(selectCiRun([run({ event: 'pull_request' }), run({ head_sha: 'b'.repeat(40) })], 'a'.repeat(40)), undefined);
  const newer = run({ id: 2, created_at: '2026-09-19T01:00:00Z', conclusion: 'failure' });
  assert.equal(selectCiRun([run(), newer], 'a'.repeat(40)).id, 2);
  await assert.rejects(waitForCi(ciHarness([{ runs: [run(), newer] }])), /Required CI did not pass/);
});
test('CI pending transitions to success, and transient networking can recover', async () => {
  const result = await waitForCi(ciHarness([new Error('network'), { status: 503 }, { status: 429 }, { runs: [run({ status: 'in_progress', conclusion: null })] }, { runs: [run()] }]));
  assert.equal(result.conclusion, 'success');
});
for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped']) {
  test(`CI rejects ${conclusion}`, async () => {
    await assert.rejects(waitForCi(ciHarness([{ runs: [run({ conclusion })] }])), /Required CI did not pass/);
  });
}
test('CI fails closed on missing evidence, permission errors and wait timeout', async () => {
  await assert.rejects(waitForCi(ciHarness([{ runs: [] }])), /No CI push-run evidence/);
  await assert.rejects(waitForCi(ciHarness([{ status: 403 }])), /actions:read/);
  await assert.rejects(waitForCi(ciHarness([{ runs: [run({ status: 'in_progress', conclusion: null })] }])), /Timed out/);
});

function resourceFixture(t, swapGiB = 3) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'release-resources-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  put(dir, 'meminfo', `MemTotal: 16777216 kB\nSwapTotal: ${swapGiB * 1048576} kB\n`);
  const env = { ...process.env, RELEASE_MEMINFO_PATH: path.join(dir, 'meminfo'), RELEASE_SWAP_PATH: path.join(dir, 'new.swap'), RELEASE_SWAP_GIB: '12', RELEASE_MIN_RAM_GIB: '12', RELEASE_FREE_DISK_GIB: '16' };
  return { dir, env };
}
const resourceScript = path.join(project, 'scripts/ci/prepare-linux-release.sh');
for (const [swap, extra] of [[0, 12292], [3, 9220], [12, 0], [16, 0]]) {
  test(`swap plan with ${swap}GiB requests ${extra}MiB, not an existence-only check`, (t) => {
    const f = resourceFixture(t, swap); const r = spawnSync('bash', [resourceScript, '--plan'], { env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, new RegExp(`add=${extra}MiB`));
  });
}
test('resource preflight rejects invalid budgets, insufficient RAM and missing kernel counters', (t) => {
  const f = resourceFixture(t);
  assert.notEqual(spawnSync('bash', [resourceScript, '--plan'], { env: { ...f.env, RELEASE_SWAP_GIB: 'x' } }).status, 0);
  put(f.dir, 'meminfo', 'MemTotal: 7340032 kB\nSwapTotal: 3145728 kB\n');
  assert.notEqual(spawnSync('bash', [resourceScript, '--plan'], { env: f.env }).status, 0);
  put(f.dir, 'meminfo', 'MemTotal: 16777216 kB\n');
  assert.notEqual(spawnSync('bash', [resourceScript, '--plan'], { env: f.env }).status, 0);
});
function mockResourceCommands(f) {
  const scripts = {
    sudo: 'exec "$@"',
    df: 'if [[ "$1" == "-B1" ]]; then printf "Avail\\n%s\\n" "${MOCK_FREE_BYTES:-1099511627776}"; else echo "mock disk"; fi',
    free: 'cat "$RELEASE_MEMINFO_PATH"',
    fallocate: '[[ "${MOCK_FALLOCATE_FAIL:-0}" != 1 ]] || exit 1; echo "${2%M}" > "$MOCK_ALLOCATION"',
    dd: 'for arg in "$@"; do [[ "$arg" != count=* ]] || echo "${arg#count=}" > "$MOCK_ALLOCATION"; done',
    mkswap: 'exit 0',
    swapon: 'if [[ "${1:-}" == --show ]]; then echo "mock swap"; exit 0; fi; [[ "${MOCK_SWAPON_FAIL:-0}" != 1 ]] || exit 1; printf "MemTotal: 16777216 kB\\nSwapTotal: 12587008 kB\\n" > "$RELEASE_MEMINFO_PATH"',
  };
  for (const [name, body] of Object.entries(scripts)) {
    put(f.dir, `bin/${name}`, `#!/usr/bin/env bash\nset -e\n${body}\n`);
    execFileSync('chmod', ['+x', path.join(f.dir, `bin/${name}`)]);
  }
  f.env.PATH = `${path.join(f.dir, 'bin')}:${process.env.PATH}`;
  f.env.MOCK_ALLOCATION = path.join(f.dir, 'allocation');
}
test('swap preparation adds capacity without swapoff, with a tested dd fallback', (t) => {
  for (const fallback of [false, true]) {
    const f = resourceFixture(t); mockResourceCommands(f);
    if (fallback) f.env.MOCK_FALLOCATE_FAIL = '1';
    const r = spawnSync('bash', [resourceScript], { env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.ok(existsSync(f.env.RELEASE_SWAP_PATH));
    assert.equal(readFileSync(f.env.MOCK_ALLOCATION, 'utf8').trim(), '9220');
  }
});
test('swap preparation fails on activation/disk errors and preserves existing paths', (t) => {
  const a = resourceFixture(t); mockResourceCommands(a); a.env.MOCK_SWAPON_FAIL = '1';
  assert.notEqual(spawnSync('bash', [resourceScript], { env: a.env }).status, 0);
  assert.equal(existsSync(a.env.RELEASE_SWAP_PATH), false);
  const b = resourceFixture(t); mockResourceCommands(b); b.env.MOCK_FREE_BYTES = '1024';
  assert.notEqual(spawnSync('bash', [resourceScript], { env: b.env }).status, 0);
  assert.equal(existsSync(b.env.RELEASE_SWAP_PATH), false);
  const c = resourceFixture(t); mockResourceCommands(c); put(c.dir, 'new.swap', 'do not overwrite');
  assert.notEqual(spawnSync('bash', [resourceScript], { env: c.env }).status, 0);
  assert.equal(readFileSync(c.env.RELEASE_SWAP_PATH, 'utf8'), 'do not overwrite');
});
const monitor = path.join(project, 'scripts/ci/with-resource-monitor.sh');
test('resource monitor preserves success/failure and produces live diagnostics', { skip: process.platform !== 'linux' }, (t) => {
  const f = resourceFixture(t);
  for (const code of [0, 17]) {
    const r = spawnSync('bash', [monitor, 'bash', '-c', `exit ${code}`], { encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: f.dir, RELEASE_METRICS_INTERVAL_SECONDS: '0.1' }, timeout: 8000 });
    assert.equal(r.status, code, r.stderr);
    assert.match(readFileSync(path.join(f.dir, 'release-resource-metrics.log'), 'utf8'), /release resource sample/);
  }
});
test('resource monitor forwards TERM to its isolated build group and exits promptly', { skip: process.platform !== 'linux' }, async (t) => {
  const f = resourceFixture(t);
  const child = spawn('bash', [monitor, 'bash', '-c', 'sleep 30'], { env: { ...process.env, RUNNER_TEMP: f.dir, RELEASE_METRICS_INTERVAL_SECONDS: '0.1' }, stdio: 'ignore' });
  const timer = setTimeout(() => child.kill('SIGTERM'), 300);
  const failSafe = setTimeout(() => child.kill('SIGKILL'), 5000);
  const code = await new Promise((resolve) => child.once('exit', resolve));
  clearTimeout(timer); clearTimeout(failSafe);
  assert.equal(code, 143);
});

test('main and rebuild wire the same frozen SHA and CI gate to every release consumer', () => {
  for (const name of ['release.yml', 'rebuild-release.yml']) {
    const source = readProject(`.github/workflows/${name}`);
    assert.match(source, /group: release-desktop-\$\{\{ github.repository \}\}/);
    assert.match(source, /uses: .\/\.github\/workflows\/reusable-release-pipeline.yml/);
  }
  const pipeline = readProject('.github/workflows/reusable-release-pipeline.yml');
  assert.match(pipeline, /check_release_metadata: true/);
  assert.match(pipeline, /check_release_secrets: true/);
  assert.match(pipeline, /uses: .\/\.github\/workflows\/reusable-release-ci-gate.yml/);
  assert.equal((pipeline.match(/source_sha: \$\{\{ needs.verify.outputs.source_sha \}\}/g) || []).length, 8);
  assert.match(pipeline, /needs: \[verify, macos-arm, macos-intel, windows, linux\]/);
  assert.match(pipeline, /needs: \[verify, publish\]/);
});
test('all shared builders obtain tooling independently of the historical source tag', () => {
  for (const platform of ['frontend', 'linux', 'macos', 'windows', 'android']) {
    const source = readProject(`.github/workflows/reusable-build-${platform}.yml`);
    assert.match(source, /ref: \$\{\{ inputs.source_sha \|\| inputs.(?:tag_name|ref) \}\}/);
    assert.match(source, /ref: \$\{\{ github.workflow_sha \}\}\n          path: .release-tooling/);
    assert.match(source, /release-contracts.mjs source/);
    if (platform !== 'frontend') {
      assert.match(source, /Refresh release lock metadata and third-party notices\n        if: \$\{\{ inputs.source_sha == '' \}\}/);
      assert.match(source, /cargo metadata --locked/);
      assert.match(source, /provenance-write/);
      assert.match(source, /frontend-check/);
    }
  }
});
test('publication checks identities before uploads, rechecks tags, and serializes every writer', () => {
  const source = readProject('.github/workflows/reusable-publish.yml');
  assert.ok(source.indexOf('artifacts-check') < source.indexOf('- name: Upload assets to GitHub Release'));
  assert.ok(source.indexOf('pointer-check') < source.indexOf('- name: Upload assets to GitHub Release'));
  assert.ok((source.match(/release-contracts.mjs tag-check/g) || []).length >= 3);
  assert.match(source, /Generate R2 latest.json\n        if: \$\{\{ steps.pointer.outputs.update == 'true' \}\}/);
  for (const file of ['reusable-publish.yml', 'rebuild-android.yml', 'hotfix-linux-release.yml']) {
    assert.match(readProject(`.github/workflows/${file}`), /group: release-assets-\$\{\{ github.repository \}\}/);
  }
});

test('standalone recovery freezes refs and preserves historical distribution semantics', () => {
  const android = readProject('.github/workflows/rebuild-android.yml');
  assert.match(android, /source_ref: \$\{\{ steps.source.outputs.sha \}\}/);
  assert.match(android, /release-contracts.mjs android-manifest/);
  assert.match(android, /left global latest.*unchanged/);
  const linux = readProject('.github/workflows/hotfix-linux-release.yml');
  assert.match(linux, /tag_name: \$\{\{ needs.verify.outputs.source_sha \}\}/);
  assert.match(linux, /release-contracts.mjs tag-check/);
});
