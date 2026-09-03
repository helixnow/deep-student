#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noticePath = path.join(repoRoot, 'legal', 'THIRD_PARTY_NOTICES.txt');

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// release-please 的版本 bump 只改写 package-lock.json 的根 version 与
// packages[""].version，依赖闭包并未变化；哈希前剔除这两个字段，
// 否则每个发布提交都会因版本号变化而无法通过本校验。
function sha256PackageLock(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  delete data.version;
  if (data.packages && data.packages['']) delete data.packages[''].version;
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function fail(message) {
  console.error(`[license-compliance] ${message}`);
  process.exitCode = 1;
}

function normalizedLicense(manifest, lockedPackage) {
  if (typeof manifest.license === 'string') return manifest.license;
  if (Array.isArray(manifest.licenses)) {
    const values = manifest.licenses
      .map((license) => typeof license === 'string' ? license : license?.type)
      .filter(Boolean);
    if (values.length) return values.join(' OR ');
  }
  return typeof lockedPackage.license === 'string' ? lockedPackage.license : '';
}

function hasLegalFile(directory) {
  if (!fs.existsSync(directory)) return false;
  return fs.readdirSync(directory, { withFileTypes: true }).some(
    (entry) => entry.isFile() && /^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/i.test(entry.name),
  );
}

if (!fs.existsSync(noticePath)) {
  fail('Missing legal/THIRD_PARTY_NOTICES.txt. Run npm run licenses:generate.');
} else {
  const notices = fs.readFileSync(noticePath, 'utf8');
  for (const [label, lockPath] of [
    ['Cargo.lock', path.join(repoRoot, 'src-tauri', 'Cargo.lock')],
    ['package-lock.json', path.join(repoRoot, 'package-lock.json')],
  ]) {
    const expected = label === 'package-lock.json' ? sha256PackageLock(lockPath) : sha256(lockPath);
    if (!notices.includes(`${label} SHA256: ${expected}`)) {
      fail(`${label} changed without regenerating third-party notices.`);
    }
  }
  for (const required of ['rs-fsrs@1.2.1', 'lancedb@0.22.1', 'object_store@0.12.4', 'PDFium chromium/7350']) {
    if (!notices.includes(required)) fail(`Generated notices do not include ${required}.`);
  }
  for (const required of ['format@0.2.2', 'unzipper@0.12.5']) {
    if (!notices.includes(required)) fail(`Generated notices do not include ${required}.`);
  }
  if (/\bLicense: UNKNOWN\b/.test(notices)) fail('Generated notices contain an unknown license.');
  if (/\/(?:Users|Volumes)\//.test(notices) || /[A-Za-z]:\\\\Users\\\\/.test(notices)) {
    fail('Generated notices contain a machine-specific absolute path.');
  }
  for (const match of notices.matchAll(/^  License: (.+)$/gm)) {
    const license = match[1];
    const hasPermissiveAlternative = /\bOR\b/.test(license)
      && /\b(?:MIT|Apache-2\.0|BSD-[23]-Clause|ISC|Zlib)\b/i.test(license);
    if (!hasPermissiveAlternative && /GPL-2\.0-only|SSPL|BUSL|Commons-Clause|UNLICENSED|Proprietary/i.test(license)) {
      fail(`License requires explicit compatibility review: ${license}`);
    }
  }
}

const npmLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
for (const forbiddenPackage of ['node_modules/buffers', 'node_modules/binary']) {
  if (npmLock.packages?.[forbiddenPackage]) {
    fail(`${forbiddenPackage} reintroduces the legacy dependency without complete license metadata.`);
  }
}
for (const [packagePath, lockedPackage] of Object.entries(npmLock.packages || {})) {
  if (!packagePath.includes('node_modules/') || lockedPackage.dev === true) continue;
  const directory = path.join(repoRoot, packagePath);
  const manifestPath = path.join(directory, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    if (lockedPackage.optional === true && lockedPackage.license) continue;
    fail(`Missing installed production package ${packagePath}; run npm ci first.`);
    continue;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!normalizedLicense(manifest, lockedPackage) && !hasLegalFile(directory)) {
    fail(`${manifest.name || packagePath}@${manifest.version || lockedPackage.version} has no declared license or license file.`);
  }
}

const tauriConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const resources = tauriConfig.bundle?.resources || {};
const requiredResources = {
  '../LICENSE': 'licenses/DeepStudent-AGPL-3.0.txt',
  '../legal/THIRD_PARTY_NOTICES.txt': 'licenses/THIRD_PARTY_NOTICES.txt',
  'vendor/lancedb/LICENSE': 'licenses/lancedb-Apache-2.0.txt',
  'vendor/object_store/LICENSE.txt': 'licenses/object_store-LICENSE.txt',
  'vendor/object_store/NOTICE.txt': 'licenses/object_store-NOTICE.txt',
  'vendor/rs-fsrs/LICENSE': 'licenses/rs-fsrs-MIT.txt',
  'resources/pdfium/LICENSE.pdfium-binaries': 'licenses/pdfium-binaries-MIT.txt',
  'resources/pdfium/licenses/': 'licenses/pdfium/',
};
for (const [source, destination] of Object.entries(requiredResources)) {
  if (resources[source] !== destination) fail(`Missing Tauri resource mapping: ${source} -> ${destination}`);
  const sourcePath = path.resolve(repoRoot, 'src-tauri', source);
  if (!fs.existsSync(sourcePath)) fail(`Missing bundled license source: ${sourcePath}`);
}

if (!process.exitCode) console.log('[license-compliance] OK');
