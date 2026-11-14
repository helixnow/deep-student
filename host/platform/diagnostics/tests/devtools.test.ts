import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import diagnostics from '../index.ts';

it('toggle_devtools asks the shell to toggle the calling window and returns the new state', async () => {
  const requests: { op: string; args: unknown }[] = [];
  let opened = true;
  const host = await createTestHost({
    plugins: [diagnostics],
    provide: { storage: { database: () => ({}) } },
    shell: (op, args) => {
      requests.push({ op, args });
      return opened;
    },
  });
  try {
    expect(await host.invoke('toggle_devtools')).toBe(true);
    opened = false;
    expect(await host.invoke('toggle_devtools', {}, { window: 'main', webview: 'main' })).toBe(false);
    expect(requests).toEqual([
      { op: 'webview.toggle_devtools', args: { __window: 'main' } },
      { op: 'webview.toggle_devtools', args: { __window: 'main' } },
    ]);
  } finally {
    await host.dispose();
  }
});

it('toggle_devtools surfaces shell failures as Rust-style string errors', async () => {
  const host = await createTestHost({
    plugins: [diagnostics],
    provide: { storage: { database: () => ({}) } },
    shell: () => { throw new Error('devtools unavailable'); },
  });
  try {
    await expect(host.invoke('toggle_devtools')).rejects.toBe('devtools unavailable');
  } finally {
    await host.dispose();
  }
});
