// g3-normalize.mjs is split into modules (values, N-014 clock); a compare names the normalization
// it was made with by normalizerSha256, so every module must be under that hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { NORMALIZER_FILES, normalizerSha256 } from '../../../scripts/electron-migration/record/g3-normalize.mjs';
import { copyNormalizer } from './__fixtures__/normalizer.mjs';

const ENTRY = 'scripts/electron-migration/record/g3-normalize.mjs';

/** Repository paths of `file` and every module it imports by relative specifier, transitively. */
function relativeClosure(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /\bimport\s*\(/, `${file}: a dynamic import would escape this closure`);
  for (const [, specifier] of source.matchAll(/^import\s[^;]*?\sfrom\s+'([^']+)';?$/gm)) {
    if (specifier.startsWith('.')) relativeClosure(posix.normalize(posix.join(dirname(file), specifier)), seen);
  }
  return seen;
}

test('normalizer modules: NORMALIZER_FILES is the entry and exactly its relative-import closure', () => {
  assert.equal(NORMALIZER_FILES[0], ENTRY);
  assert.deepEqual([...relativeClosure(ENTRY)].sort(), [...NORMALIZER_FILES].sort());
  for (const file of NORMALIZER_FILES) assert.ok(readFileSync(file, 'utf8').split('\n').length < 800, `${file} stays under ~800 lines`);
});

test('normalizerSha256: identical trees agree; an edit to any one module changes it', t => {
  const root = mkdtempSync(join(tmpdir(), 'w13-normalizer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyNormalizer(root);
  const base = normalizerSha256(root);
  assert.equal(base, normalizerSha256('.'));
  for (const file of NORMALIZER_FILES) {
    const original = readFileSync(join(root, file));
    writeFileSync(join(root, file), `${original}\n// edited\n`);
    assert.notEqual(normalizerSha256(root), base, `${file} is under the hash`);
    writeFileSync(join(root, file), original);
  }
  assert.equal(normalizerSha256(root), base);
});
