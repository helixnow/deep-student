#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mobileRuntimePackages, packageLockHash, shippedNpmPackages } from './licenses/shipped-npm-packages.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Electron copies this into resources/licenses/; Vite serves it to the frontend in development.
const outputPath = path.join(repoRoot, 'legal', 'THIRD_PARTY_NOTICES.txt');
const legalFilePattern = /^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Shrinks a legal text without touching its wording: strips trailing
// whitespace, collapses blank-line runs, and removes common indentation.
function compactWhitespace(text) {
  const lines = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/[ \t]+$/, '');
    if (!line && !lines[lines.length - 1]) continue;
    lines.push(line);
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const indents = lines.filter(Boolean).map((line) => /^ */.exec(line)[0].length);
  const indent = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(indent)).join('\n');
}

// Identity of a legal text for deduplication: its exact word sequence,
// ignoring formatting differences (wrapping, indentation, blank lines).
function wordKey(text) {
  return sha256(text.split(/\s+/).filter(Boolean).join(' '));
}

function readText(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) return null;
  return compactWhitespace(buffer.toString('utf8').replace(/\r\n/g, '\n').trim());
}

function legalFilesIn(directory, explicitFile, sourceBase = '') {
  const candidates = new Set();
  if (explicitFile) {
    const resolvedExplicitFile = path.isAbsolute(explicitFile)
      ? explicitFile
      : path.resolve(directory, explicitFile);
    if (fs.existsSync(resolvedExplicitFile)) candidates.add(resolvedExplicitFile);
  }
  if (fs.existsSync(directory)) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && legalFilePattern.test(entry.name)) {
        candidates.add(path.join(directory, entry.name));
      }
    }
  }
  return [...candidates]
    .sort()
    .map((filePath) => ({
      source: sourceBase
        ? path.posix.join(sourceBase, path.relative(directory, filePath).split(path.sep).join('/'))
        : path.relative(repoRoot, filePath).split(path.sep).join('/') || path.basename(filePath),
      text: readText(filePath),
    }))
    .filter((item) => item.text);
}

function repositoryUrl(repository) {
  if (typeof repository === 'string') return repository;
  if (repository && typeof repository.url === 'string') return repository.url;
  return '';
}

function npmLicense(manifest, lockedPackage) {
  if (typeof manifest.license === 'string') return manifest.license;
  if (Array.isArray(manifest.licenses)) {
    const values = manifest.licenses
      .map((license) => typeof license === 'string' ? license : license?.type)
      .filter(Boolean);
    if (values.length) return values.join(' OR ');
  }
  return typeof lockedPackage.license === 'string' ? lockedPackage.license : 'UNKNOWN';
}

const ASSET_LICENSE_SUBDIRS = new Map([
  ['pdfjs-dist', ['cmaps', 'iccs', 'standard_fonts', 'wasm']],
]);

function appendUniqueLegalFiles(record, candidateFiles) {
  const knownTexts = new Set(record.legalFiles.map((item) => sha256(item.text)));
  for (const legalFile of candidateFiles) {
    const hash = sha256(legalFile.text);
    if (!knownTexts.has(hash)) {
      record.legalFiles.push(legalFile);
      knownTexts.add(hash);
    }
  }
}

function appendOverrideNotice(record, name, version) {
  const overridePath = path.join(repoRoot, 'scripts', 'license-overrides', `${name.replaceAll('/', '__')}@${version}.txt`);
  if (!fs.existsSync(overridePath)) return;
  const text = readText(overridePath);
  if (text) {
    appendUniqueLegalFiles(record, [{
      source: `scripts/license-overrides/${path.basename(overridePath)}`,
      text,
    }]);
  }
}

// 按“实际进入产物的包”取舍（Electron 运行时闭包 + 前端 bundle 清单），不按 lock 的 dev 标记：
// 前端打包进 dist 的库是 devDependencies，构建工具虽是生产依赖的同类也不会进产物。见 licenses/shipped-npm-packages.mjs。
export function collectNpmRecords() {
  const { lock, shipped } = shippedNpmPackages(repoRoot);
  const records = new Map();

  for (const packagePath of [...shipped.keys()].sort()) {
    const lockedPackage = lock.packages[packagePath];
    const packageDirectory = path.join(repoRoot, packagePath);
    const manifestPath = path.join(packageDirectory, 'package.json');
    if (!fs.existsSync(manifestPath)) {
      if (lockedPackage.optional === true && lockedPackage.license) {
        const name = packagePath.split('node_modules/').at(-1);
        const version = lockedPackage.version || 'unknown';
        records.set(`${name}@${version}`, {
          ecosystem: 'NPM',
          id: `${name}@${version}`,
          license: lockedPackage.license,
          repository: '',
          legalFiles: [],
        });
        continue;
      }
      throw new Error(`Missing installed production package: ${packagePath}. Run npm ci first.`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const name = manifest.name || packagePath.replace(/^.*node_modules\//, '');
    const version = manifest.version || lockedPackage.version || 'unknown';
    const id = `${name}@${version}`;
    const record = records.get(id) || {
      ecosystem: 'NPM',
      id,
      license: npmLicense(manifest, lockedPackage),
      repository: repositoryUrl(manifest.repository),
      legalFiles: [],
    };
    appendUniqueLegalFiles(record, legalFilesIn(packageDirectory, undefined, `npm/${id}`));
    for (const subdir of ASSET_LICENSE_SUBDIRS.get(name) ?? []) {
      appendUniqueLegalFiles(record, legalFilesIn(path.join(packageDirectory, subdir), undefined, `npm/${id}/${subdir}`));
    }
    appendOverrideNotice(record, name, version);
    if (record.license === 'UNKNOWN' && record.legalFiles.some((item) => /\bMIT License\b/i.test(item.text))) {
      record.license = 'MIT';
    }
    records.set(id, record);
  }

  return [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// The WASM is already built; its recorded dependency notices ship without a Cargo workspace.
function collectPrebuiltWasmRecords() {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'legal/f7-native-wasm-components.json'), 'utf8'));
  return {
    mplSourceAvailabilityNotice: manifest.mplSourceAvailabilityNotice || '',
    records: manifest.components.map(({ id, license, repository, notices }) => ({
      ecosystem: 'F7 WASM',
      id,
      license,
      repository,
      legalFiles: notices.map(({ source, text }) => ({ source, text: manifest.texts[text] })),
    })),
  };
}

function collectDesktopRuntimeRecords(npmLock) {
  const electronVersion = npmLock.packages?.['node_modules/electron']?.version || 'unknown';
  const electronLicensePath = path.join(repoRoot, 'electron', 'native', 'LICENSE.electron');
  const electronLicenseText = fs.existsSync(electronLicensePath)
    ? readText(electronLicensePath)
    : readText(path.join(repoRoot, 'node_modules', 'electron', 'LICENSE'));

  return [
    {
      ecosystem: 'Desktop runtime',
      id: `Electron@${electronVersion}`,
      license: 'MIT',
      repository: 'https://github.com/electron/electron',
      legalFiles: electronLicenseText ? [{ source: 'electron/native/LICENSE.electron', text: electronLicenseText }] : [],
    },
    {
      ecosystem: 'Desktop runtime',
      id: 'Chromium',
      license: 'BSD-3-Clause AND Multiple-OSS',
      repository: 'https://www.chromium.org/Home',
      legalFiles: [{
        source: 'desktop/chromium-notice',
        text: [
          `Chromium (embedded via Electron ${electronVersion})`,
          'Copyright 2015 The Chromium Authors. All rights reserved.',
          '',
          'Desktop distributions of DeepStudent bundle Chromium inside the Electron runtime.',
          'Chromium and its third-party components are licensed under BSD-3-Clause and other',
          'open-source licenses; the complete machine-generated Chromium notice bundle ships',
          'as LICENSES.chromium.html in the Electron application distribution.',
        ].join('\n'),
      }],
    },
    {
      ecosystem: 'Desktop runtime',
      id: 'Node.js',
      license: 'MIT',
      repository: 'https://github.com/nodejs/node',
      legalFiles: [{
        source: 'desktop/nodejs-notice',
        text: [
          `Node.js (embedded via Electron ${electronVersion})`,
          'Copyright Node.js contributors. All rights reserved.',
          '',
          'Desktop distributions of DeepStudent execute the Host runtime on Node.js',
          'embedded inside Electron under the MIT License (and bundled dependency notices',
          'included in the Node.js / Electron distribution).',
        ].join('\n'),
      }],
    },
  ];
}

function collectMobileRuntimeRecords() {
  const { lock, shipped } = mobileRuntimePackages(repoRoot);
  const records = new Map();

  for (const packagePath of [...shipped].sort()) {
    const lockedPackage = lock.packages?.[packagePath] ?? {};
    const packageDirectory = path.join(repoRoot, 'mobile', packagePath);
    const manifestPath = path.join(packageDirectory, 'package.json');
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
    const name = manifest.name || packagePath.replace(/^.*node_modules\//, '');
    const version = manifest.version || lockedPackage.version || 'unknown';
    const id = `${name}@${version}`;
    const record = records.get(id) || {
      ecosystem: 'Mobile runtime',
      id,
      license: npmLicense(manifest, lockedPackage),
      repository: repositoryUrl(manifest.repository),
      legalFiles: [],
    };
    if (fs.existsSync(packageDirectory)) {
      appendUniqueLegalFiles(record, legalFilesIn(packageDirectory, undefined, `mobile/${id}`));
    }
    appendOverrideNotice(record, name, version);
    records.set(id, record);
  }

  return {
    mobileLockHash: packageLockHash(lock),
    records: [...records.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function collectBundledAssetRecords() {
  const wallpaperAttribution = path.join(repoRoot, 'public', 'wallpapers', 'study-os', 'ATTRIBUTION.md');

  return [
    {
      ecosystem: 'Bundled font',
      id: 'Noto Sans SC',
      license: 'OFL-1.1',
      repository: 'https://github.com/notofonts/noto-cjk',
      legalFiles: [{ source: 'public/fonts/paper-export/OFL.txt', text: readText(path.join(repoRoot, 'public/fonts/paper-export/OFL.txt')) }],
    },
    {
      ecosystem: 'Bundled media',
      id: 'Study OS wallpapers',
      license: 'CC0-1.0',
      repository: '',
      legalFiles: [{ source: path.relative(repoRoot, wallpaperAttribution), text: readText(wallpaperAttribution) }],
    },
  ];
}

function wrapList(values, indent = '  ') {
  return values.map((value) => `${indent}${value}`).join('\n');
}

// The Apache-2.0 terms and conditions (sections 1-9) are word-for-word
// identical across dozens of dependency license files; these markers delimit
// that block so it can be stored once instead of per package. Some upstream
// files omit the "END OF TERMS AND CONDITIONS" line, so the closing words of
// section 9 serve as a fallback end marker.
const commonBlockStart = 'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'.split(' ');
const commonBlockEnds = [
  'END OF TERMS AND CONDITIONS'.split(' '),
  'of your accepting any such warranty or additional liability.'.split(' '),
];

function tokenize(text) {
  const tokens = [];
  for (const match of text.matchAll(/\S+/g)) {
    tokens.push({ word: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function findWordSequence(words, sequence, fromIndex = 0) {
  for (let i = fromIndex; i <= words.length - sequence.length; i += 1) {
    let found = true;
    for (let k = 0; k < sequence.length; k += 1) {
      if (words[i + k] !== sequence[k]) {
        found = false;
        break;
      }
    }
    if (found) return i;
  }
  return -1;
}

// Replaces license-terms blocks shared verbatim (word-for-word) by two or
// more notices with a reference to a single COMMON TEXT entry.
function factorCommonTexts(notices) {
  const groups = new Map();
  for (const notice of notices.values()) {
    const tokens = tokenize(notice.text);
    const words = tokens.map((token) => token.word);
    const startIndex = findWordSequence(words, commonBlockStart);
    if (startIndex < 0) continue;
    let endIndex = -1;
    let endLength = 0;
    for (const candidate of commonBlockEnds) {
      const index = findWordSequence(words, candidate, startIndex + commonBlockStart.length);
      if (index >= 0) {
        endIndex = index;
        endLength = candidate.length;
        break;
      }
    }
    if (endIndex < 0) continue;
    const start = tokens[startIndex].start;
    const end = tokens[endIndex + endLength - 1].end;
    const groupKey = sha256(words.slice(startIndex, endIndex + endLength).join(' '));
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ notice, start, end });
  }

  const commonTexts = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const id = `C${commonTexts.length + 1}`;
    commonTexts.push({ id, text: members[0].notice.text.slice(members[0].start, members[0].end) });
    for (const { notice, start, end } of members) {
      notice.text = [
        notice.text.slice(0, start).trim(),
        `[Terms identical to COMMON TEXT ${id}; see the COMMON LICENSE TEXTS section above.]`,
        notice.text.slice(end).trim(),
      ].filter(Boolean).join('\n\n');
    }
  }
  return commonTexts;
}

function render(records, npmLockHash, mobileLockHash, mplSourceAvailabilityNotice) {
  const unknown = records.filter(
    (record) => record.license === 'UNKNOWN' && record.legalFiles.length === 0,
  );
  if (unknown.length) {
    throw new Error(`Dependencies without license metadata or a license file:\n${wrapList(unknown.map((item) => item.id))}`);
  }

  const notices = new Map();
  const inventory = [];
  for (const record of records) {
    const noticeIds = new Set();
    for (const legalFile of record.legalFiles) {
      const key = wordKey(legalFile.text);
      if (!notices.has(key)) {
        notices.set(key, { id: `N${notices.size + 1}`, text: legalFile.text });
      }
      noticeIds.add(notices.get(key).id);
    }
    inventory.push(
      `${record.ecosystem}: ${record.id}\n` +
      `  License: ${record.license}` +
      (noticeIds.size ? `\n  Notices: ${[...noticeIds].join(', ')}` : ''),
    );
  }

  const commonTexts = factorCommonTexts(notices);

  return [
    'DEEPSTUDENT THIRD-PARTY NOTICES',
    '',
    'This file contains license and attribution material for third-party',
    'components distributed with DeepStudent. NPM packages are listed when they',
    'ship: the Electron runtime closure, the packages rendered into the frontend',
    'bundle (dependency type does not matter), the mobile runtime dependencies,',
    'and the embedded desktop runtime acknowledgments (Electron, Chromium, Node.js).',
    'Third-party components in the prebuilt F7 WASM are listed from its bundled',
    'license inventory.',
    ...(mplSourceAvailabilityNotice ? ['', mplSourceAvailabilityNotice] : []),
    '',
    'Generated by: scripts/generate-third-party-notices.mjs',
    `package-lock.json SHA256: ${npmLockHash}`,
    `mobile/package-lock.json SHA256: ${mobileLockHash}`,
    '',
    `Components: ${records.length}`,
    `Distinct legal texts: ${notices.size}`,
    `Common license texts: ${commonTexts.length}`,
    '',
    'Format:',
    '- COMPONENT INVENTORY lists each component with its license expression and',
    '  the ids of the notice texts that ship with it. Components without a',
    '  "Notices:" line are covered by their license expression alone.',
    '- A license body shared verbatim by several notices is printed once in the',
    '  COMMON LICENSE TEXTS section and referenced as COMMON TEXT C<n>.',
    '- Each NOTICE N<n> section reproduces one distinct license/notice text.',
    '',
    '='.repeat(80),
    'COMPONENT INVENTORY',
    '='.repeat(80),
    '',
    inventory.join('\n'),
    '',
    '='.repeat(80),
    'COMMON LICENSE TEXTS',
    '='.repeat(80),
    '',
    ...commonTexts.map((common) => `==== COMMON TEXT ${common.id} ====\n${common.text}\n`),
    '='.repeat(80),
    'LICENSE AND NOTICE TEXTS',
    '='.repeat(80),
    '',
    ...[...notices.values()].map((notice) => `==== NOTICE ${notice.id} ====\n${notice.text}\n`),
  ].join('\n').trimEnd() + '\n';
}

function main() {
  const npmLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const wasm = collectPrebuiltWasmRecords();
  const mobile = collectMobileRuntimeRecords();
  const records = [
    ...wasm.records,
    ...collectNpmRecords(),
    ...collectDesktopRuntimeRecords(npmLock),
    ...mobile.records,
    ...collectBundledAssetRecords(),
  ];
  const output = render(records, packageLockHash(npmLock), mobile.mobileLockHash, wasm.mplSourceAvailabilityNotice);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, 'utf8');
  console.log(`Wrote ${path.relative(repoRoot, outputPath)} (${records.length} components).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
