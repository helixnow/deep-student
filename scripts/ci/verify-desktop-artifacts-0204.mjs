import assert from 'node:assert/strict';
import { constants, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetInventory, verifyMetadata, TARGETS } from './release-contracts.mjs';
import { verifyMinisign } from '../../electron/shell/minisign.ts';

const sourceSha = '81c7b46d31ebb99beccfc71170934dc0cfd64b17';
const workflowSha = '1a219c2a21e38ae1c40eaa03b51894ecf9773bf0';
const repo = join(import.meta.dirname, '../..');
const version = '0.20.4';
const { npmLockSha256, mobileLockSha256 } = verifyMetadata(repo, version);
const key = JSON.parse(readFileSync(join(repo, 'resources/app/tauri.conf.json'), 'utf8')).plugins.updater.pubkey;
assert.ok(key);
const targets = {
  'aarch64-apple-darwin': ['_aarch64.app.tar.gz', '_aarch64.app.tar.gz.sig', '_aarch64.dmg'],
  'x86_64-apple-darwin': ['_x86_64.app.tar.gz', '_x86_64.app.tar.gz.sig', '_x86_64.dmg'],
  'x86_64-pc-windows-msvc': ['_x64-setup.exe', '_x64-setup.exe.sig'],
};
const rawFolder = process.argv[2];
assert.ok(rawFolder);
const stage = join(rawFolder, 'verified-release-assets');
const all = [];
let frontend;
for (const [target, suffixes] of Object.entries(targets)) {
  const folder = join(rawFolder, TARGETS[target].artifact);
  const proof = JSON.parse(readFileSync(join(rawFolder, `release-provenance-${target}`, 'release-provenance.json'), 'utf8'));
  assert.equal(proof.schemaVersion, 1);
  assert.deepEqual([proof.target, proof.sourceSha, proof.workflowSha, proof.version, proof.npmLockSha256, proof.mobileLockSha256],
    [target, sourceSha, workflowSha, version, npmLockSha256, mobileLockSha256]);
  assert.match(proof.frontendSha256, /^[0-9a-f]{64}$/);
  frontend ??= proof.frontendSha256;
  assert.equal(proof.frontendSha256, frontend);
  const actual = await assetInventory(folder, target);
  assert.deepEqual(actual, proof.files);
  assert.deepEqual(actual.map(a => a.name), suffixes.map(s => `Deep.Student_${version}${s}`).sort());
  const paths = new Map(readdirSync(folder).map(name => [name.replaceAll(' ', '.'), join(folder, name)]));
  for (const asset of actual) {
    if (asset.name.endsWith('.sig')) {
      verifyMinisign(readFileSync(paths.get(asset.name.slice(0, -4))), readFileSync(paths.get(asset.name), 'utf8').trim(), key);
      console.log(`Updater signature verified: ${asset.name}`);
    }
    all.push({ asset, path: paths.get(asset.name) });
  }
}
assert.equal(new Set(all.map(x => x.asset.name)).size, 8);
mkdirSync(stage);
for (const { asset, path } of all) copyFileSync(path, join(stage, asset.name), constants.COPYFILE_EXCL);
writeFileSync(join(rawFolder, 'verified-manifest.json'), JSON.stringify(all.map(x => x.asset), null, 2) + '\n', { flag: 'wx' });
console.log(`Verified eight assets from ${sourceSha}; frontend SHA-256: ${frontend}`);
