#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPackaging from '../electron/electron-builder.config.cjs';
import { mobileRuntimePackages, packageLockHash, shippedNpmPackages } from './licenses/shipped-npm-packages.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noticePath = path.join(repoRoot, 'legal', 'THIRD_PARTY_NOTICES.txt');

const npmLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
const { lock: mobileLock, shipped: mobileShipped } = mobileRuntimePackages(repoRoot);

const FORBIDDEN_GPL2_ONLY = new RegExp(`GPL-${'2\\.0-only'}`, 'i');
const SPDX_GPL2_ONLY_RE = new RegExp(`SPDX-License-Identifier:\\s*GPL-${'2\\.0-only'}\\b`, 'i');
const SOURCE_EXT_RE = /\.(?:c|cc|cpp|h|hpp|rs|ts|tsx|mts|cts|js|mjs|cjs|swift|py|sh)$/i;
const SKIP_SCAN_DIRS = new Set([
  'node_modules', '.git', '.github', 'dist', 'dist-web', '.vite',
  '.build', 'playwright-report', 'test-results', 'coverage',
]);

function hasPermissiveOrAlternative(license) {
  return /\bOR\b/.test(license) && /\b(?:MIT|Apache-2\.0|BSD-[23]-Clause|ISC|Zlib)\b/i.test(license);
}

function isDisallowedLicense(license) {
  if (!license) return false;
  if (hasPermissiveOrAlternative(license)) return false;
  return /SSPL|BUSL|Commons-Clause|UNLICENSED|Proprietary/i.test(license) || FORBIDDEN_GPL2_ONLY.test(license);
}

function scanSourceFilesForGpl2Only(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_SCAN_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path.relative(repoRoot, full).split(path.sep).join('/') === 'mobile/dist') continue;
      scanSourceFilesForGpl2Only(full);
    } else if (entry.isFile() && SOURCE_EXT_RE.test(entry.name)) {
      const content = fs.readFileSync(full, 'utf8');
      if (SPDX_GPL2_ONLY_RE.test(content)) {
        fail(`Disallowed GPL-2.0-only SPDX header in source file: ${path.relative(repoRoot, full).split(path.sep).join('/')}`);
      }
    }
  }
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
  if (!notices.includes(`package-lock.json SHA256: ${packageLockHash(npmLock)}`)) {
    fail('package-lock.json changed without regenerating third-party notices.');
  }
  if (!notices.includes(`mobile/package-lock.json SHA256: ${packageLockHash(mobileLock)}`)) {
    fail('mobile/package-lock.json changed without regenerating third-party notices.');
  }
  const wasm = JSON.parse(fs.readFileSync(path.join(repoRoot, 'legal/f7-native-wasm-components.json'), 'utf8'));
  for (const component of wasm.components) {
    if (!notices.includes(`F7 WASM: ${component.id}\n`)) fail(`Generated notices do not include F7 WASM component ${component.id}.`);
    if (isDisallowedLicense(component.license)) {
      fail(`F7 WASM component ${component.id} has disallowed license: ${component.license}`);
    }
    if ((/^symphonia(?:[-@]|$)/.test(component.id) || component.id.startsWith('priority-queue@')) && (!component.notices || component.notices.length === 0)) {
      fail(`F7 WASM MPL-2.0 component ${component.id} is missing copyright/license notices.`);
    }
  }
  if (!notices.includes('https://github.com/helixnow/deep-student')) {
    fail('Generated notices are missing the MPL-2.0 Section 3.2(b) repository source availability notice.');
  }
  for (const required of ['@embedpdf/pdfium', 'format@0.2.2', 'unzipper@0.12.5', 'pako@1.0.11', 'pdfjs-dist@']) {
    if (!notices.includes(`NPM: ${required}`)) fail(`Generated notices do not include ${required}.`);
  }
  for (const desktopEntry of ['Desktop runtime: Electron@', 'Desktop runtime: Chromium', 'Desktop runtime: Node.js']) {
    if (!notices.includes(desktopEntry)) fail(`Generated notices do not include ${desktopEntry}.`);
  }
  for (const mobileEntry of ['@capacitor/core', '@capacitor/android', '@capacitor/ios', '@sqlite.org/sqlite-wasm', 'tslib']) {
    if (!notices.includes(`Mobile runtime: ${mobileEntry}@`)) fail(`Generated notices do not include Mobile runtime ${mobileEntry}.`);
  }
  for (const requiredText of ['SIL OPEN FONT LICENSE', 'PDFium Authors', 'Universite catholique de Louvain', 'qcms', 'Jean-loup Gailly and Mark Adler']) {
    if (!notices.includes(requiredText)) fail(`Generated notices are missing required bundled/library attribution text: ${requiredText}.`);
  }
  if (/\bLicense: UNKNOWN\b/.test(notices)) fail('Generated notices contain an unknown license.');
  if (/\/(?:Users|Volumes)\//.test(notices) || /[A-Za-z]:\\\\Users\\\\/.test(notices)) {
    fail('Generated notices contain a machine-specific absolute path.');
  }
  for (const match of notices.matchAll(/^  License: (.+)$/gm)) {
    const license = match[1];
    if (isDisallowedLicense(license)) {
      fail(`License requires explicit compatibility review: ${license}`);
    }
  }
}

for (const [lockName, lockData] of [['package-lock.json', npmLock], ['mobile/package-lock.json', mobileLock]]) {
  for (const [pkgPath, entry] of Object.entries(lockData.packages ?? {})) {
    if (typeof entry?.license === 'string' && isDisallowedLicense(entry.license) && FORBIDDEN_GPL2_ONLY.test(entry.license)) {
      fail(`${lockName} contains disallowed GPL-2.0-only package ${pkgPath} (${entry.license}).`);
    }
  }
}

for (const packagePath of [...mobileShipped].sort()) {
  const lockedPackage = mobileLock.packages?.[packagePath];
  if (!lockedPackage?.license) {
    fail(`Mobile runtime package ${packagePath} has no declared license in mobile/package-lock.json.`);
  } else if (isDisallowedLicense(lockedPackage.license)) {
    fail(`Mobile runtime package ${packagePath} has disallowed license: ${lockedPackage.license}`);
  }
}

scanSourceFilesForGpl2Only(repoRoot);

for (const forbiddenPackage of ['node_modules/buffers', 'node_modules/binary']) {
  if (npmLock.packages?.[forbiddenPackage]) {
    fail(`${forbiddenPackage} reintroduces the legacy dependency without complete license metadata.`);
  }
}
// 与生成器同一口径：实际进入产物的包（含前端 bundle 里的 devDependencies），清单过期时报错。
let shipped = new Map();
try {
  ({ shipped } = shippedNpmPackages(repoRoot));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
for (const packagePath of [...shipped.keys()].sort()) {
  const lockedPackage = npmLock.packages[packagePath];
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

for (const [from, to] of [
  ['LICENSE', 'licenses/DeepStudent-AGPL-3.0.txt'],
  ['legal/THIRD_PARTY_NOTICES.txt', 'licenses/THIRD_PARTY_NOTICES.txt'],
]) {
  if (!electronPackaging.extraResources.some((resource) => resource.from === from && resource.to === to)) {
    fail(`Missing Electron license resource: ${from} -> ${to}`);
  }
  if (!fs.existsSync(path.join(repoRoot, from))) fail(`Missing bundled license source: ${from}`);
}

if (!process.exitCode) console.log('[license-compliance] OK');
