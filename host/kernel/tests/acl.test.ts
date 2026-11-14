import { expect, it } from 'vitest';
import { CapabilityAcl } from '../acl.ts';
import { createTestHost, definePlugin } from '../testing.ts';
import { GLOBAL_SHORTCUT_TRIGGERED } from '../api.ts';

it('checks registered commands before argument decoding and keeps browser webview isolated', async () => {
  const host = await createTestHost({ acl: CapabilityAcl.fromDirectory('darwin'), plugins: [definePlugin({
    meta: { id: 'acl-test', commands: ['plugin_list'] }, apply(ctx) { ctx.commands.register('plugin_list', () => []); },
  })] });
  try {
    await expect(host.invoke('plugin_list')).resolves.toEqual([]);
    await expect(host.invoke('plugin_list', {}, { window: 'main', webview: 'browser-content' })).rejects.toBe(
      'plugin_list not allowed on window "main", webview "browser-content", URL: local\n\nallowed on: [webviews: "main", URL: local]\n\nreferenced by: capability: default, permission: allow-application-commands');
  } finally { await host.dispose(); }
});

it('auxiliary windows receive only their capability and release uses opaque denial', () => {
  const acl = CapabilityAcl.fromDirectory('linux');
  expect(acl.denial('get_setting', { window: 'pomodoro-mini', webview: 'pomodoro-mini' }, true)).toBeNull();
  expect(acl.denial('chat_v2_send_message', { window: 'quick-assistant', webview: 'quick-assistant' }, true)).toBeNull();
  expect(acl.denial('plugin_list', { window: 'quick-assistant', webview: 'quick-assistant' }, false)).toBe('Command plugin_list not allowed by ACL');
  expect(acl.denial('browser_content_user_input', { window: 'main', webview: 'browser-content', origin: 'https://example.org/' }, true)).toBeNull();
  expect(acl.denial('plugin_list', { window: 'main', webview: 'main', origin: 'https://example.org/' }, false)).toBe('Command plugin_list not allowed by ACL');
});

it('matches window/webview labels with glob::Pattern semantics', () => {
  const acl = new CapabilityAcl(
    [{
      identifier: 'glob',
      windows: ['main-?', '[!x]indow', 'chat[0-9]'],
      webviews: ['[ab]view'],
      permissions: ['allow-glob'],
    }],
    [{ identifier: 'allow-glob', allow: ['glob_command'], deny: [] }],
    'linux',
  );
  expect(acl.denial('glob_command', { window: 'main-a', webview: 'aview' }, true)).toBeNull();
  expect(acl.denial('glob_command', { window: 'main-ab', webview: 'cview' }, true)).not.toBeNull();
  expect(acl.denial('glob_command', { window: 'window', webview: 'bview' }, true)).toBeNull();
  expect(acl.denial('glob_command', { window: 'window', webview: 'cview' }, true)).toBeNull();
  expect(acl.denial('glob_command', { window: 'xindow', webview: 'cview' }, true)).not.toBeNull();
  expect(acl.denial('glob_command', { window: 'chat7', webview: 'aview' }, true)).toBeNull();
  expect(acl.denial('glob_command', { window: 'chatx', webview: 'cview' }, true)).not.toBeNull();
  expect(acl.denial('glob_command', { window: 'main-a', webview: 'cview' }, true)).toBeNull();
});

it('remote capability URLs use URLPattern with Tauri pathname defaults and deny wins for every origin', () => {
  const acl = new CapabilityAcl(
    [{
      identifier: 'remote',
      local: false,
      remote: { urls: ['https://example.org/'] },
      webviews: ['browser-content'],
      permissions: ['allow-remote'],
    }],
    [
      { identifier: 'allow-remote', allow: ['remote_command'], deny: [] },
      { identifier: 'deny-remote', allow: [], deny: ['remote_command'] },
    ],
    'linux',
  );
  expect(acl.denial('remote_command', { window: 'main', webview: 'browser-content', origin: 'https://example.org/path?q=1#hash' }, true)).toBeNull();
  expect(acl.denial('remote_command', { window: 'main', webview: 'browser-content', origin: 'https://other.example/path' }, true)).toContain('not allowed on window');
  expect(acl.denial('remote_command', { window: 'main', webview: 'browser-content' }, true)).toContain('not allowed on window');

  const denying = new CapabilityAcl(
    [{
      identifier: 'deny-any-origin',
      local: true,
      remote: { urls: ['https://example.org/*'] },
      permissions: ['deny-remote'],
    }],
    [{ identifier: 'deny-remote', allow: [], deny: ['remote_command'] }],
    'linux',
  );
  // Tauri 2.11.5 authority.rs:419-428 uses Option::is_some() on the origin test: one
  // deny entry rejects the command even from an origin that does not match it.
  expect(denying.denial('remote_command', { window: 'main', webview: 'main' }, true)).toContain('explicitly denied on origin local');
});

it('forwards global-shortcut FrontendEvent unchanged to L17 listeners', async () => {
  const seen: unknown[] = [];
  const host = await createTestHost({ plugins: [definePlugin({ meta: { id: 'shortcut-consumer' }, apply(ctx) {
    ctx.backendEvents.listen(GLOBAL_SHORTCUT_TRIGGERED, (payload, source) => { seen.push({ payload, source }); });
  } })] });
  try {
    const payload = { shortcut: 'CommandOrControl+Shift+Space', state: 'Pressed' };
    host.emitFrontend(GLOBAL_SHORTCUT_TRIGGERED, payload);
    expect(seen).toEqual([{ payload, source: { window: 'main', webview: 'main' } }]);
  } finally { await host.dispose(); }
});
