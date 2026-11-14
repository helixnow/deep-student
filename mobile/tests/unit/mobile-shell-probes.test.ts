import { describe, expect, it } from 'vitest';
import { MobileShell } from '../../src/shell/mobile-shell.ts';
import { rendererInvoker } from './support/renderer.ts';

describe('mobile shell native probes', () => {
  it.each([
    ['plugin:window|is_visible', true],
    ['plugin:window|is_focused', true],
    ['plugin:window|is_minimized', false],
    ['plugin:window|set_focus', null],
    ['plugin:window|show', null],
    ['plugin:window|unminimize', null],
    ['plugin:notification|is_permission_granted', false],
    ['plugin:notification|request_permission', 'denied'],
    ['plugin:notification|notify', null],
  ])('answers %s without forwarding to Host ACL', async (command, body) => {
    const invoke = rendererInvoker(new MobileShell({
      handshake: { appDataDir: '/deep-student', appVersion: 'test', platform: 'linux', debug: false },
    }));
    expect(await invoke(command as string)).toEqual({ ok: true, body });
  });
});
