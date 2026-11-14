import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import { BiliTaskRegistry } from '../src/bilibili-tasks.ts';
import { CancellationToken } from '../src/handout.ts';

it('registers media_bilibili_cancel and treats unknown ids as a no-op', async () => {
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings: { get: () => null, save: () => undefined }, paths: { appDataDir: process.cwd() } },
  });
  try {
    expect(await host.invoke('media_bilibili_cancel', { taskId: 'unknown' })).toBeNull();
  } finally { await host.dispose(); }
});

it('replaces same-id tokens and only cancels once', () => {
  const registry = new BiliTaskRegistry();
  const first = new CancellationToken();
  const second = new CancellationToken();
  registry.register('task', first);
  expect(registry.size()).toBe(1);
  registry.register('task', second);
  expect(first.isCancelled()).toBe(true);
  expect(second.isCancelled()).toBe(false);
  expect(registry.size()).toBe(1);

  registry.cancel('task');
  expect(second.isCancelled()).toBe(true);
  expect(registry.size()).toBe(0);
  registry.cancel('task');
  expect(second.isCancelled()).toBe(true);
});

it('removing a task leaves its token uncancelled', () => {
  const registry = new BiliTaskRegistry();
  const token = new CancellationToken();
  registry.register('task', token);
  registry.remove('task');
  expect(token.isCancelled()).toBe(false);
  expect(registry.size()).toBe(0);
});
