/**
 * 测试中的 renderer：经外壳的 `bridgeTransport()` 发 Tauri 式 invoke（成功 / 失败两个回调 id），
 * 按回调 id 收回复，body 为 JSON 时解析。
 */
import type { MainToRenderer } from '../../../../electron/shell/bridge-messages.ts';
import type { MobileShell } from '../../../src/shell/mobile-shell.ts';

export interface RendererReply {
  ok: boolean;
  body: unknown;
}

export function rendererInvoker(shell: MobileShell): (cmd: string, args?: unknown) => Promise<RendererReply> {
  const waiters = new Map<number, (reply: RendererReply) => void>();
  shell.bridgeTransport().subscribe((message: MainToRenderer) => {
    if (message.type !== 'result') return;
    const callback = Math.min(message.callbackId, message.otherId);
    const body = message.body.kind === 'json' ? JSON.parse(message.body.data) as unknown : message.body.data;
    waiters.get(callback)?.({ ok: message.callbackId === callback, body });
    waiters.delete(callback);
  });
  let next = 0;
  return (cmd, args = {}) => new Promise<RendererReply>((resolve) => {
    const callback = (next += 2);
    waiters.set(callback, resolve);
    shell.bridgeTransport().send({ type: 'invoke', cmd, callback, error: callback + 1, payload: { contentType: 'application/json', data: JSON.stringify(args) }, headers: {} });
  });
}
