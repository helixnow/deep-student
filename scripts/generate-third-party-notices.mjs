#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cargoRoot = path.join(repoRoot, 'src-tauri');
const cargoLockPath = path.join(cargoRoot, 'Cargo.lock');
const npmLockPath = path.join(repoRoot, 'package-lock.json');
// 唯一权威路径（WI-9 legal 去重）：不再放 public/（避免随 frontendDist 进安装包形成双份），
// 仅经 tauri.conf.json bundle.resources 进入 resources/licenses/；前端展示走
// resolveResource 读取（web dev 由 vite 中间件代理，见 vite.config.ts legalNoticesDevPlugin）。
const outputPath = path.join(repoRoot, 'legal', 'THIRD_PARTY_NOTICES.txt');
const legalFilePattern = /^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// release-please 的版本 bump 只改写 package-lock.json 的根 version 与
// packages[""].version，依赖闭包并未变化；哈希前剔除这两个字段，
// 与 scripts/check-license-compliance.mjs 的校验口径保持一致。
function sha256PackageLock(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  delete data.version;
  if (data.packages && data.packages['']) delete data.packages[''].version;
  return sha256(JSON.stringify(data));
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

function collectNpmRecords() {
  const lock = JSON.parse(fs.readFileSync(npmLockPath, 'utf8'));
  const records = new Map();

  for (const [packagePath, lockedPackage] of Object.entries(lock.packages || {})) {
    if (!packagePath.includes('node_modules/') || lockedPackage.dev === true) continue;
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
    const overridePath = path.join(repoRoot, 'scripts', 'license-overrides', `${name.replaceAll('/', '__')}@${version}.txt`);
    const knownTexts = new Set(record.legalFiles.map((item) => sha256(item.text)));
    for (const legalFile of legalFilesIn(packageDirectory, undefined, `npm/${id}`)) {
      const hash = sha256(legalFile.text);
      if (!knownTexts.has(hash)) {
        record.legalFiles.push(legalFile);
        knownTexts.add(hash);
      }
    }
    if (fs.existsSync(overridePath)) {
      const text = readText(overridePath);
      if (text && !knownTexts.has(sha256(text))) {
        record.legalFiles.push({
          source: `scripts/license-overrides/${path.basename(overridePath)}`,
          text,
        });
      }
    }
    if (record.license === 'UNKNOWN' && record.legalFiles.some((item) => /\bMIT License\b/i.test(item.text))) {
      record.license = 'MIT';
    }
    records.set(id, record);
  }

  return [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function cargoMetadata() {
  const result = spawnSync(
    'cargo',
    ['metadata', '--locked', '--offline', '--format-version', '1'],
    { cwd: cargoRoot, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `cargo metadata failed. Run "cd src-tauri && cargo fetch --locked" first.\n${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(result.stdout);
}

function cargoRuntimePackageIds(metadata) {
  const rootManifest = path.join(cargoRoot, 'Cargo.toml');
  const rootPackage = metadata.packages.find(
    (pkg) => path.resolve(pkg.manifest_path) === rootManifest,
  );
  if (!rootPackage) throw new Error('Could not locate the DeepStudent Cargo package.');

  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const included = new Set([rootPackage.id]);
  const queue = [rootPackage.id];
  while (queue.length) {
    const node = nodes.get(queue.shift());
    if (!node) continue;
    for (const dependency of node.deps) {
      const kinds = dependency.dep_kinds || [];
      if (kinds.length && !kinds.some((kind) => kind.kind !== 'dev')) continue;
      if (!included.has(dependency.pkg)) {
        included.add(dependency.pkg);
        queue.push(dependency.pkg);
      }
    }
  }
  included.delete(rootPackage.id);
  return included;
}

function collectCargoRecords() {
  const metadata = cargoMetadata();
  const included = cargoRuntimePackageIds(metadata);
  return metadata.packages
    .filter((pkg) => included.has(pkg.id))
    .map((pkg) => {
      const directory = path.dirname(pkg.manifest_path);
      return {
        ecosystem: 'Cargo',
        id: `${pkg.name}@${pkg.version}`,
        license: pkg.license || (pkg.license_file ? 'SEE INCLUDED LICENSE FILE' : 'UNKNOWN'),
        repository: pkg.repository || '',
        legalFiles: legalFilesIn(directory, pkg.license_file, `cargo/${pkg.name}-${pkg.version}`),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function collectBundledAssetRecords() {
  const pdfiumRoot = path.join(cargoRoot, 'resources', 'pdfium');
  const binaryLicense = path.join(pdfiumRoot, 'LICENSE.pdfium-binaries');
  const componentLicenseRoot = path.join(pdfiumRoot, 'licenses');
  if (!fs.existsSync(binaryLicense) || !fs.existsSync(componentLicenseRoot)) {
    throw new Error('PDFium license files are missing. Run scripts/download-pdfium.sh for a bundled platform.');
  }

  const legalFiles = [{ source: path.relative(repoRoot, binaryLicense), text: readText(binaryLicense) }];
  for (const entry of fs.readdirSync(componentLicenseRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(componentLicenseRoot, entry.name);
    legalFiles.push({ source: path.relative(repoRoot, filePath), text: readText(filePath) });
  }
  const wallpaperAttribution = path.join(repoRoot, 'public', 'wallpapers', 'study-os', 'ATTRIBUTION.md');

  return [
    {
      ecosystem: 'Bundled binary',
      id: 'PDFium chromium/7350',
      license: 'SEE INCLUDED LICENSE FILES',
      repository: 'https://github.com/bblanchon/pdfium-binaries',
      legalFiles: legalFiles.filter((item) => item.text),
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

function render(records, cargoLockHash, npmLockHash) {
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
    'components distributed with DeepStudent. NPM development-only packages are',
    'excluded. Cargo normal and build dependency closures are included.',
    '',
    'Generated by: scripts/generate-third-party-notices.mjs',
    `Cargo.lock SHA256: ${cargoLockHash}`,
    `package-lock.json SHA256: ${npmLockHash}`,
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
  const cargoLock = fs.readFileSync(cargoLockPath);
  const records = [
    ...collectCargoRecords(),
    ...collectNpmRecords(),
    ...collectBundledAssetRecords(),
  ];
  const output = render(records, sha256(cargoLock), sha256PackageLock(npmLockPath));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, 'utf8');
  console.log(`Wrote ${path.relative(repoRoot, outputPath)} (${records.length} components).`);
}

main();
