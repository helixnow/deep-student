import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (file) => JSON.parse(readFileSync(path.join(project, file), 'utf8'));

// Tauri merges platform config with JSON Merge Patch (RFC 7396): objects merge,
// arrays are replaced. Android must replace the desktop build.features list,
// otherwise its values are appended to the explicit mobile-slim CLI feature.
function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const merged = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = mergePatch(merged[key], value);
  }
  return merged;
}

test('Android overlay must not union desktop features into the mobile-slim build', () => {
  const command = readFileSync(
    path.join(project, '.github/workflows/reusable-build-android.yml'),
    'utf8',
  )
    .split(/\r?\n/u)
    .find((line) => line.includes('npx tauri android build'));
  assert.ok(command, 'Android build command not found');
  assert.match(command, /--features mobile-slim/u);
  assert.match(command, /--\s+--locked --no-default-features/u);

  const effective = mergePatch(readJson('src-tauri/tauri.conf.json'), readJson('src-tauri/tauri.android.conf.json'));
  assert.deepEqual(
    (effective.build?.features ?? []).filter((feature) => feature === 'lance' || feature === 'mcp'),
    [],
    'tauri.android.conf.json must replace build.features; inheriting the desktop list compiles lance/mcp into mobile-slim',
  );
});
