#!/usr/bin/env node
// Release identity is a commit, not a mutable tag or a semver string.
// Adapted for the Node/Electron/Capacitor build graph (no src-tauri workspace).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FRONTEND_MANIFEST = '.deepstudent-release.json';
export const TARGETS = {
  'aarch64-apple-darwin': { artifact: 'macos-aarch64-apple-darwin', outputDirs: ['.'], suffixes: ['.dmg', '.app.tar.gz', '.app.tar.gz.sig'] },
  'x86_64-apple-darwin': { artifact: 'macos-x86_64-apple-darwin', outputDirs: ['.'], suffixes: ['.dmg', '.app.tar.gz', '.app.tar.gz.sig'] },
  'x86_64-pc-windows-msvc': { artifact: 'windows-x86_64', outputDirs: ['.'], suffixes: ['-setup.exe', '-setup.exe.sig'] },
  'x86_64-unknown-linux-gnu': { artifact: 'linux-x86_64', outputDirs: ['.'], suffixes: ['.deb', '.AppImage', '.AppImage.sig'] },
  'aarch64-linux-android': { artifact: 'android-arm64', outputDirs: ['.'], suffixes: ['.apk'] },
};

const read = (root, file) => readFileSync(path.join(root, file), 'utf8');
const json = (root, file) => JSON.parse(read(root, file));
const hash = (data) => createHash('sha256').update(data).digest('hex');
const fileHash = (root, file) => hash(readFileSync(path.join(root, file)));
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;

function requireSha(value, label = 'source SHA') {
  assert.match(value ?? '', SHA, `${label} must be a full 40-character commit SHA`);
  return value;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
}

export function assertSource(root, expectedSha) {
  requireSha(expectedSha);
  assert.equal(git(root, ['rev-parse', 'HEAD']), expectedSha, 'checkout does not match the resolved release SHA');
}

function strippedLockSha(lockObj) {
  const copy = structuredClone(lockObj);
  delete copy.version;
  if (copy.packages && copy.packages['']) delete copy.packages[''].version;
  return hash(JSON.stringify(copy));
}

export function verifyMetadata(root, expectedVersion) {
  const pkg = json(root, 'package.json');
  const version = expectedVersion || pkg.version;
  assert.match(version ?? '', VERSION, 'release version must be X.Y.Z');
  assert.equal(pkg.version, version, 'package.json version mismatch');
  assert.equal(json(root, 'resources/app/tauri.conf.json').version, version, 'resources/app/tauri.conf.json version mismatch');
  const npm = json(root, 'package-lock.json');
  assert.equal(npm.version, version, 'package-lock.json root version mismatch');
  assert.equal(npm.packages?.['']?.version, version, 'package-lock.json packages[""] version mismatch');
  const mobileLock = json(root, 'mobile/package-lock.json');
  const notices = read(root, 'legal/THIRD_PARTY_NOTICES.txt');
  const npmStrippedSha = strippedLockSha(npm);
  const mobileStrippedSha = strippedLockSha(mobileLock);
  assert.ok(notices.includes(`package-lock.json SHA256: ${npmStrippedSha}`),
    'npm lock/license notices mismatch; run npm run licenses:generate and commit the result');
  assert.ok(notices.includes(`mobile/package-lock.json SHA256: ${mobileStrippedSha}`),
    'mobile npm lock/license notices mismatch; run npm run licenses:generate and commit the result');
  return {
    version,
    npmLockSha256: fileHash(root, 'package-lock.json'),
    mobileLockSha256: fileHash(root, 'mobile/package-lock.json'),
  };
}

function identity(root, sourceSha, workflowSha) {
  assertSource(root, sourceSha);
  requireSha(workflowSha, 'workflow SHA');
  const metadata = verifyMetadata(root);
  for (const file of ['package.json', 'package-lock.json', 'mobile/package-lock.json', 'resources/app/tauri.conf.json', 'legal/THIRD_PARTY_NOTICES.txt']) {
    const original = execFileSync('git', ['-C', root, 'show', `${sourceSha}:${file}`], { maxBuffer: 16 * 1024 * 1024 });
    assert.equal(fileHash(root, file), hash(original), `release source was mutated: ${file}`);
  }
  return { schemaVersion: 1, sourceSha, workflowSha, ...metadata };
}

async function shaFile(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

function filesUnder(dir) {
  assert.ok(existsSync(dir), `missing artifact directory: ${dir}`);
  assert.ok(!lstatSync(dir).isSymbolicLink(), `artifact directory must not be a symlink: ${dir}`);
  const files = [];
  function walk(current, relative = '') {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      assert.ok(!entry.isSymbolicLink(), `artifact symlink is not allowed: ${rel}`);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) files.push({ rel, full });
    }
  }
  walk(dir);
  return files;
}

export async function distDigest(dir) {
  assert.ok(existsSync(path.join(dir, 'index.html')), 'frontend dist/index.html is missing');
  const records = [];
  for (const file of filesUnder(dir)) {
    if (file.rel === FRONTEND_MANIFEST) continue;
    records.push([file.rel, await shaFile(file.full)]);
  }
  return hash(JSON.stringify(records));
}

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export async function writeFrontend(root, sourceSha, workflowSha, dir) {
  const result = { ...identity(root, sourceSha, workflowSha), distSha256: await distDigest(dir) };
  writeJson(path.join(dir, FRONTEND_MANIFEST), result);
  return result;
}

export async function verifyFrontend(root, sourceSha, workflowSha, dir) {
  const expected = identity(root, sourceSha, workflowSha);
  const actual = json(dir, FRONTEND_MANIFEST);
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, `frontend provenance mismatch: ${key}`);
  assert.equal(actual.distSha256, await distDigest(dir), 'frontend artifact content changed');
  return actual.distSha256;
}

export async function assetInventory(dir, target, bundlerOutput = false) {
  const rule = TARGETS[target];
  assert.ok(rule, `unknown target: ${target}`);
  const records = [];
  const names = new Set();
  const candidates = bundlerOutput
    ? rule.outputDirs.flatMap((subdir) => {
      const folder = path.join(dir, subdir);
      if (!existsSync(folder)) return [];
      return readdirSync(folder, { withFileTypes: true }).filter((entry) => !entry.isDirectory()).map((entry) => ({ rel: entry.name, full: path.join(folder, entry.name) }));
    })
    : filesUnder(dir);
  for (const file of candidates) {
    if (!rule.suffixes.some((suffix) => file.rel.endsWith(suffix))) continue;
    assert.ok(lstatSync(file.full).isFile() && !lstatSync(file.full).isSymbolicLink(), `release asset must be a regular file: ${file.rel}`);
    const name = path.basename(file.rel).replaceAll(' ', '.');
    assert.ok(!names.has(name), `ambiguous artifact filename: ${name}`);
    names.add(name);
    const size = lstatSync(file.full).size;
    assert.ok(size > 0, `empty release artifact: ${name}`);
    records.push({ name, size, sha256: await shaFile(file.full) });
  }
  assert.ok(records.length > 0, `no release assets for ${target}`);
  return records.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export async function writeProvenance(root, sourceSha, workflowSha, target, artifactDir, output) {
  const data = identity(root, sourceSha, workflowSha);
  const frontendSha256 = await verifyFrontend(root, sourceSha, workflowSha, path.join(root, 'dist'));
  const result = { ...data, target, frontendSha256, files: await assetInventory(artifactDir, target, true) };
  writeJson(output, result);
  return result;
}

export async function verifyArtifacts(dir, sourceSha, workflowSha, version) {
  requireSha(sourceSha);
  requireSha(workflowSha, 'workflow SHA');
  assert.match(version ?? '', VERSION);
  let common;
  for (const [target, rule] of Object.entries(TARGETS)) {
    const artifactDir = path.join(dir, rule.artifact);
    if (target === 'aarch64-linux-android' && !existsSync(artifactDir)) continue;
    const proof = json(path.join(dir, `release-provenance-${target}`), 'release-provenance.json');
    assert.equal(proof.schemaVersion, 1, `unsupported provenance schema: ${target}`);
    assert.equal(proof.target, target, 'provenance target mismatch');
    assert.equal(proof.sourceSha, sourceSha, `wrong source SHA: ${target}`);
    assert.equal(proof.workflowSha, workflowSha, `wrong workflow SHA: ${target}`);
    assert.equal(proof.version, version, `wrong version: ${target}`);
    const fingerprint = [proof.npmLockSha256, proof.mobileLockSha256, proof.frontendSha256];
    fingerprint.forEach((value) => assert.match(value ?? '', DIGEST, 'invalid provenance digest'));
    if (common) assert.deepEqual(fingerprint, common, `platforms were not built from the same inputs: ${target}`);
    common = fingerprint;
    assert.deepEqual(await assetInventory(artifactDir, target), proof.files, `release artifact bytes differ from provenance: ${target}`);
  }
}

export function patchAndroidManifest(manifest, version, url) {
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'invalid release manifest');
  assert.match(version ?? '', VERSION);
  assert.equal(manifest.version, version, 'APK target version differs from release manifest');
  assert.equal(new URL(url).protocol, 'https:', 'APK URL must use HTTPS');
  assert.ok(manifest.android == null || (typeof manifest.android === 'object' && !Array.isArray(manifest.android)), 'invalid Android manifest state');
  return { ...manifest, apk_url: url, android: { ...(manifest.android || {}), status: 'available', url } };
}

export function pointerDecision(currentVersion, nextVersion) {
  assert.match(currentVersion ?? '', VERSION, 'current updater version must be X.Y.Z');
  assert.match(nextVersion ?? '', VERSION, 'candidate updater version must be X.Y.Z');
  const current = currentVersion.split('.').map(BigInt);
  const next = nextVersion.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (next[i] > current[i]) return 'advance';
    if (next[i] < current[i]) return 'skip-older';
  }
  return 'refresh';
}

export function checkSecrets(env = process.env) {
  // Android stays optional for desktop publication; its own job remains fail-closed.
  const required = ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
  if (env.ALLOW_UNSIGNED_DESKTOP !== 'true') {
    required.push('APPLE_CERTIFICATE_BASE64', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_TEAM_ID', 'WINDOWS_CERTIFICATE_BASE64', 'WINDOWS_CERTIFICATE_PASSWORD');
    if (!env.APPLE_APP_SPECIFIC_PASSWORD && !env.APPLE_PASSWORD) {
      required.push('APPLE_PASSWORD');
    }
  }
  const missing = required.filter((name) => !env[name]);
  assert.equal(missing.length, 0, `Missing required release secrets: ${missing.join(', ')}`);
}

export function verifyTag(root, tag, expectedSha) {
  assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/u, 'invalid release tag');
  requireSha(expectedSha);
  const lines = git(root, ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).split('\n');
  const refs = new Map(lines.filter(Boolean).map((line) => { const [sha, ref] = line.split(/\s+/u); return [ref, sha]; }));
  const current = refs.get(`refs/tags/${tag}^{}`) || refs.get(`refs/tags/${tag}`);
  assert.equal(current, expectedSha, 'release tag moved or disappeared after verification; refusing to publish');
}

function parseArgs(args) {
  const options = {};
  while (args.length) {
    const name = args.shift();
    assert.match(name ?? '', /^--[a-z-]+$/u, 'invalid option');
    assert.ok(args.length, `missing value: ${name}`);
    options[name.slice(2)] = args.shift();
  }
  return options;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseArgs(args);
  const root = path.resolve(options.root || '.');
  const sha = options['source-sha'] || process.env.RELEASE_SOURCE_SHA;
  const workflow = options['workflow-sha'] || process.env.RELEASE_WORKFLOW_SHA;
  const dir = path.resolve(options.dir || 'dist');
  switch (command) {
    case 'source': assertSource(root, sha); verifyMetadata(root, options.version); break;
    case 'metadata': verifyMetadata(root, options.version); break;
    case 'secrets': checkSecrets(); break;
    case 'android-manifest': {
      assert.ok(options.file && options.output && options.url, '--file, --output and --url are required');
      writeJson(options.output, patchAndroidManifest(JSON.parse(readFileSync(options.file, 'utf8')), options.version, options.url));
      break;
    }
    case 'pointer-check': {
      assert.ok(options.file, '--file is required');
      const decision = pointerDecision(JSON.parse(readFileSync(options.file, 'utf8')).version, options.version);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `update=${decision !== 'skip-older'}\n`);
      console.log(`[release-contracts] updater pointer policy: ${decision}`);
      break;
    }
    case 'frontend-write': await writeFrontend(root, sha, workflow, dir); break;
    case 'frontend-check': await verifyFrontend(root, sha, workflow, dir); break;
    case 'provenance-write':
      assert.ok(options.output, '--output is required');
      await writeProvenance(root, sha, workflow, options.target, dir, options.output); break;
    case 'artifacts-check': await verifyArtifacts(dir, sha, workflow, options.version); break;
    case 'tag-check': verifyTag(root, options.tag, sha); break;
    default: throw new Error(`Unknown release contract command: ${command}`);
  }
  console.log(`[release-contracts] ${command}: OK`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[release-contracts] ${error.message}`); process.exitCode = 1; });
}
