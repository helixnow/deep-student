import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APPROVALS, BATCH, createRunManifest, verifyRunManifest } from '../../../scripts/electron-migration/record/g3-manifest.mjs';
import { NORMALIZER_FILES } from '../../../scripts/electron-migration/record/g3-normalize.mjs';

test('G3 manifest: seals HEAD, all equivalence JSON bytes, rule versions and A/A2/B compare references', async () => {
  const root = await mkdtemp('/tmp/opencode/x7-manifest-');
  const runs = 'fixtures/differential/g3/runs/full';
  const suite = 'host/plugins/demo/equivalence/demo.json';
  const sidecar = 'host/plugins/demo/equivalence/demo.provider.json';
  const file = join(root, runs, 'RUN-MANIFEST.json');
  const put = async (path, text) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); };
  try {
    await mkdir(join(root, 'electron'));
    for (const path of [APPROVALS, BATCH, ...NORMALIZER_FILES]) await put(path, '{}');
    await put(suite, '{"scenarios":[]}');
    await put(sidecar, '{"responses":[]}');
    const artifact = { traces: Object.fromEntries(['A', 'A2', 'B'].map(side => [side, { file: `${runs}/${side}/trace.json`, sha256: side }])) };
    await put(`${runs}/compare/one.compare.json`, JSON.stringify(artifact));
    await put(`${runs}/compare/two.compare.json`, JSON.stringify(artifact));
    // Old compares must not contaminate the final ledger.
    await put(`${runs}/compare.pre-final-old/unreadable.compare.json`, 'not json');
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root });
    const suites = [{ file: suite }];
    const manifest = createRunManifest(root, runs, suites);
    await writeFile(file, JSON.stringify(manifest));
    assert.equal(manifest.compares.length, 2);
    assert.deepEqual(Object.values(manifest.sides).map(side => side.count), [1, 1, 1]);
    assert.ok(manifest.scenarioFiles.includes(sidecar));
    assert.equal(verifyRunManifest(root, runs, suites).head, manifest.head);
    // A forged progress file is not read or included in the seal.
    await put(`${runs}/progress.json`, '{"equal":999999,"bDone":999999}');
    assert.equal(verifyRunManifest(root, runs, suites).sha256.length, 64);
    for (const key of ['head', 'scenarioTreeSha256', 'normalizerSha256', 'approvalsSha256', 'batchVersion', 'sides']) {
      await writeFile(file, JSON.stringify({ ...manifest, [key]: 'tampered' }));
      assert.throws(() => verifyRunManifest(root, runs, suites), new RegExp(`mismatch: ${key}`));
    }
    await writeFile(file, JSON.stringify(manifest));
    await put(sidecar, '{"responses":[1]}');
    assert.throws(() => verifyRunManifest(root, runs, suites), /mismatch: scenarioTreeSha256/);
    await put(sidecar, '{"responses":[]}');
    await put(`${runs}/compare/two.compare.json`, JSON.stringify({ ...artifact, equal: false }));
    assert.throws(() => verifyRunManifest(root, runs, suites), /mismatch: compares/);
    await put(`${runs}/compare/two.compare.json`, JSON.stringify(artifact));
    await rm(file);
    assert.throws(() => verifyRunManifest(root, runs, suites), /ENOENT/);
    assert.equal(await readFile(join(root, runs, 'progress.json'), 'utf8'), '{"equal":999999,"bDone":999999}');
  } finally { await rm(root, { recursive: true }); }
});
