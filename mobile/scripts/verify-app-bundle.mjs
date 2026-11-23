#!/usr/bin/env node
/**
 * Fail-closed post-build verification for `mobile/dist` (runs in <1s with pure Node, no browser required).
 * Guards against打包期 regressions such as broken `toBundles` namespace stripping (the v0.20.7 Android raw-key bug)
 * or mismatched `APP_VERSION` inside built mobile assets.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(mobileDir, '..');
const distDir = join(mobileDir, 'dist');
const assetsDir = join(distDir, 'assets');

function fail(message) {
  console.error(`[verify-app-bundle] FAIL: ${message}`);
  process.exit(1);
}

if (!existsSync(join(distDir, 'index.html'))) {
  fail(`Missing ${join(distDir, 'index.html')} — run "npm --prefix mobile run build" first.`);
}
if (!existsSync(assetsDir)) {
  fail(`Missing ${assetsDir}`);
}

const assetFiles = readdirSync(assetsDir);
const findSingle = (pattern, label) => {
  const matches = assetFiles.filter((f) => pattern.test(f));
  if (matches.length === 0) fail(`Missing built asset for ${label} (${pattern})`);
  return join(assetsDir, matches[0]);
};

const toBundlesFile = findSingle(/^toBundles-.*\.js$/, 'toBundles');
const zhBundleFile = findSingle(/^zh-CN-.*\.js$/, 'zh-CN locale bundle');
const enBundleFile = findSingle(/^en-US-.*\.js$/, 'en-US locale bundle');
const appEntryFile = findSingle(/^_dstu-app-entry-.*\.js$/, 'app entry chunk');

// 1. Dynamically import built `toBundles` helper and verify it strips the exact glob keys emitted in built locale bundles.
const toBundlesMod = await import(pathToFileURL(toBundlesFile).href);
const toBundlesFn = Object.values(toBundlesMod).find((v) => typeof v === 'function');
if (typeof toBundlesFn !== 'function') {
  fail(`Built ${toBundlesFile} does not export a toBundles function`);
}

for (const [locale, bundleFile] of [['zh-CN', zhBundleFile], ['en-US', enBundleFile]]) {
  const expectedNs = readdirSync(join(repoRoot, 'src/locales', locale))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();

  const code = readFileSync(bundleFile, 'utf8');
  const globKeys = [...new Set([...code.matchAll(/"([^"]*\/(?:zh-CN|en-US)\/[^"]+\.json)"\s*:/g)].map((m) => m[1]))];
  if (globKeys.length < expectedNs.length) {
    fail(`${locale} bundle (${bundleFile}) only contains ${globKeys.length} glob keys, expected ${expectedNs.length}`);
  }

  const mapped = toBundlesFn(Object.fromEntries(globKeys.map((k) => [k, { __ok: true }])));
  const actualNs = Object.keys(mapped).sort();
  const missing = expectedNs.filter((ns) => !actualNs.includes(ns));
  const malformed = actualNs.filter((ns) => ns.includes('..') || ns.includes('/') || ns.includes('\\') || ns.endsWith('.json'));

  if (missing.length > 0) {
    fail(`${locale} bundle missing normalized namespaces: ${missing.join(', ')}`);
  }
  if (malformed.length > 0) {
    fail(`${locale} bundle leaked malformed namespace keys: ${malformed.join(', ')}`);
  }
}

// 2. Verify APP_VERSION in built mobile entry matches root package.json.
const expectedVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const entryCode = readFileSync(appEntryFile, 'utf8');
if (!entryCode.includes(`APP_VERSION:"${expectedVersion}"`)) {
  fail(`Built ${appEntryFile} does not contain APP_VERSION:"${expectedVersion}"`);
}

console.log(`[verify-app-bundle] OK: zh-CN & en-US mobile bundles normalized cleanly and APP_VERSION=${expectedVersion} verified.`);
