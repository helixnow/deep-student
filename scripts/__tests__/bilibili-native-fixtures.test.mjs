import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('every Bilibili client uses the unified transport, not a second CDN or auth client', () => {
  for (const name of ['bilibili', 'bilibili_auth', 'bilibili_stream']) {
    const source = readFileSync(new URL(`../../src-tauri/src/media/${name}.rs`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /reqwest::Client(?:::|\b)/, name);
  }
});
test('local and CI builds sync the same Android bridge service', () => {
  for (const name of ['../../scripts/build_android.sh', '../../.github/workflows/reusable-build-android.yml']) {
    assert.match(readFileSync(new URL(name, import.meta.url), 'utf8'), /scripts\/ci\/prepare-bilibili-android\.mjs/);
  }
});
