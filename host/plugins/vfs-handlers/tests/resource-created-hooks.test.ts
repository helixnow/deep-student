import { afterEach, beforeEach, expect, it } from 'vitest';
import { createVfsHost, type VfsHost } from './harness.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { await vfs?.dispose(); }, 120_000);

it('publishes the real vfsHooks resource-created registry and notifies in registration order', () => {
  const hooks = vfs.host.ctx.vfsHooks;
  const calls: string[] = [];
  const hook = { onResourceCreated: (id: string) => { calls.push(`first:${id}`); } };
  const remove = hooks.registerResourceCreatedHook(hook);
  const removeSecondRegistration = hooks.registerResourceCreatedHook(hook);
  const removeThird = hooks.registerResourceCreatedHook({ onResourceCreated: id => { calls.push(`third:${id}`); } });
  hooks.notifyResourceCreated('file_media');
  expect(calls).toEqual(['first:file_media', 'first:file_media', 'third:file_media']);
  remove();
  remove(); // Disposing one registration twice must not remove the other registration of the same hook.
  calls.length = 0;
  hooks.notifyResourceCreated('file_again');
  expect(calls).toEqual(['first:file_again', 'third:file_again']);
  removeSecondRegistration();
  removeThird();
  calls.length = 0;
  hooks.notifyResourceCreated('file_removed');
  expect(calls).toEqual([]);
});

it('snapshots resource-created callbacks before hooks add/remove registrations', () => {
  const hooks = vfs.host.ctx.vfsHooks;
  const calls: string[] = [];
  let removeSecond = () => {};
  let mutate = true;
  hooks.registerResourceCreatedHook({ onResourceCreated: () => {
    calls.push('first');
    if (mutate) {
      mutate = false;
      removeSecond();
      hooks.registerResourceCreatedHook({ onResourceCreated: () => { calls.push('new'); } });
    }
  } });
  removeSecond = hooks.registerResourceCreatedHook({ onResourceCreated: () => { calls.push('second'); } });
  hooks.notifyResourceCreated('file_media');
  expect(calls).toEqual(['first', 'second']);
  calls.length = 0;
  hooks.notifyResourceCreated('file_next');
  expect(calls).toEqual(['first', 'new']);
});
