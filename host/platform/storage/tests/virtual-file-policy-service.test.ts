import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { definePlugin } from '../../../kernel/api.ts';
import { createTestHost, type TestPluginEntry } from '../../../kernel/testing.ts';
import secrets from '../../secrets/index.ts';
import storage from '../index.ts';
import { isVirtualUri } from '../node.ts';

let base: string;
let host: Awaited<ReturnType<typeof createTestHost>> | undefined;

beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-virtual-file-policy-')); });
afterEach(async () => {
  await host?.dispose();
  host = undefined;
  fs.rmSync(base, { recursive: true, force: true });
});

async function start(plugins: readonly TestPluginEntry[] = []) {
  host = await createTestHost({
    app: { dataDir: base },
    plugins: [secrets, [storage, { dataLocalDir: base }], ...plugins],
    provide: {
      paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base } },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
      storageStartupSync: { resetDefaultAfterLocalPurge() {} },
    },
    shell: () => null,
  });
  return host;
}

// unified_file_manager.rs:16/19 SPECIAL_SCHEMES / ANDROID_SAF_PREFIXES, :413 trim + case-insensitive prefix.
const cases: Array<[string, boolean]> = [
  ['content://com.android.providers.downloads/document/1', true],
  ['asset://localhost/a.png', true],
  ['ph://ABC-123', true],
  ['image://picked/1', true],
  ['camera://capture/1', true],
  ['primary:Download/QQ/file.pdf', true],
  ['secondary:Documents/a.xmind', true],
  ['raw:/storage/emulated/0/Download/a.opml', true],
  ['  CONTENT://Upper/Case  ', true],
  ['\u3000Primary:Download/a.pdf', true],
  ['/home/user/notes/a.xmind', false],
  ['C:\\Users\\a\\b.mm', false],
  ['file:///tmp/a.opml', false],
  ['tauri://localhost/a.png', false],
  ['content%3A%2F%2Fdoc%2F1', false],
  ['contents://x', false],
  ['', false],
];

it('virtualFilePolicy provider is the storage api isVirtualUri (unified_file_manager.rs:413)', async () => {
  expect(storage.meta.provides).toContain('virtualFilePolicy');
  const h = await start();
  const policy = h.ctx.get('virtualFilePolicy');
  expect(policy).toBeDefined();
  expect(policy!.isVirtualUri).toBe(isVirtualUri);
  for (const [input, expected] of cases) {
    expect(policy!.isVirtualUri(input), input).toBe(expected);
    expect(policy!.isVirtualUri(input), input).toBe(isVirtualUri(input));
  }
});

it('virtualFilePolicy stays available in startup recovery mode', async () => {
  // Same layout as the recovery fixtures: a slot with an unrelated db plus a legacy root db.
  fs.mkdirSync(path.join(base, 'slots/slotB'), { recursive: true });
  fs.writeFileSync(path.join(base, 'slots/slotB/cache.db'), 'unrelated');
  fs.writeFileSync(path.join(base, 'unrelated.db'), 'legacy');
  const h = await start();
  expect(h.ctx.dataSpace.status().recovery_required).toBe(true);
  expect(h.ctx.virtualFilePolicy.isVirtualUri('content://downloads/a.xmind')).toBe(true);
  expect(h.ctx.virtualFilePolicy.isVirtualUri(path.join(base, 'a.xmind'))).toBe(false);
});

it('consumer injecting virtualFilePolicy is applied with storage and disposed when storage unloads', async () => {
  const seen: string[] = [];
  const consumer = definePlugin({
    meta: { id: 'fixture.virtual-file-policy-consumer' },
    apply(ctx) {
      ctx.inject(['virtualFilePolicy'], (scoped) => {
        seen.push(`apply:${scoped.virtualFilePolicy.isVirtualUri('ph://asset')}`);
        scoped.effect(() => () => { seen.push('dispose'); });
      });
    },
  });
  const h = await start([consumer]);
  expect(seen).toEqual(['apply:true']);

  await h.unload('dstu.platform.storage');
  expect(seen).toEqual(['apply:true', 'dispose']);
  expect(h.ctx.get('virtualFilePolicy')).toBeUndefined();
});
