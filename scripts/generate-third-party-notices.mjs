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
const outputPath = path.join(repoRoot, 'public', 'legal', 'THIRD_PARTY_NOTICES.txt');
const legalFilePattern = /^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readText(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8').replace(/\r\n/g, '\n').trim();
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
    const noticeIds = [];
    for (const legalFile of record.legalFiles) {
      const hash = sha256(legalFile.text);
      if (!notices.has(hash)) {
        notices.set(hash, { text: legalFile.text, packages: new Set(), sources: new Set() });
      }
      const notice = notices.get(hash);
      notice.packages.add(`${record.ecosystem}: ${record.id}`);
      notice.sources.add(legalFile.source);
      noticeIds.push(hash.slice(0, 12));
    }
    inventory.push(
      `${record.ecosystem}: ${record.id}\n` +
      `  License: ${record.license}\n` +
      `  Notices: ${noticeIds.length ? [...new Set(noticeIds)].join(', ') : 'license expression only'}\n` +
      (record.repository ? `  Upstream: ${record.repository}\n` : ''),
    );
  }

  const noticeSections = [...notices.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hash, notice]) => [
      '='.repeat(80),
      `NOTICE ${hash.slice(0, 12)}`,
      'Applies to:',
      wrapList([...notice.packages].sort()),
      'Source license files:',
      wrapList([...notice.sources].sort()),
      '-'.repeat(80),
      notice.text,
      '',
    ].join('\n'));

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
    '',
    '='.repeat(80),
    'COMPONENT INVENTORY',
    '='.repeat(80),
    '',
    inventory.join('\n'),
    ...noticeSections,
  ].join('\n').trimEnd() + '\n';
}

function main() {
  const cargoLock = fs.readFileSync(cargoLockPath);
  const npmLock = fs.readFileSync(npmLockPath);
  const records = [
    ...collectCargoRecords(),
    ...collectNpmRecords(),
    ...collectBundledAssetRecords(),
  ];
  const output = render(records, sha256(cargoLock), sha256(npmLock));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, 'utf8');
  console.log(`Wrote ${path.relative(repoRoot, outputPath)} (${records.length} components).`);
}

main();
