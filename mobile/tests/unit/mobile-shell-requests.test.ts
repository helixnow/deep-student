import { describe, expect, it } from 'vitest';
import { MobileShell } from '../../src/shell/mobile-shell.ts';

describe('mobile shell requests', () => {
  it('replies with an error when the platform handler throws synchronously', async () => {
    const shell = new MobileShell({
      handshake: { appDataDir: '/deep-student', appVersion: 'test', platform: 'linux', debug: false },
      onShellRequest() { throw new Error('native plugin unavailable'); },
    });
    const channel = new MessageChannel();
    const replies: unknown[] = [];
    channel.port2.addEventListener('message', event => replies.push(event.data));
    channel.port2.start();
    shell.attach(channel.port1, { onReady() {}, onFatal() {}, onExit() {} });
    try {
      channel.port2.postMessage({ kind: 'shell-request', id: 's1', op: 'http.fetch', args: {} });
      await expect.poll(() => replies).toContainEqual({
        kind: 'shell-result', id: 's1', ok: false, error: 'native plugin unavailable',
      });
    } finally {
      shell.detach('test finished');
      channel.port2.close();
    }
  });
});
