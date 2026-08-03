/**
 * A45-5（docs/dev/acr/ACR-4.5.md）— chat scrollToMessage 虚拟化长会话修复测试
 *
 * scrollToMessage 不再靠 role="log" 子节点 DOM 定位（虚拟化 >80 条必失败），
 * 改走 features/chat 的 messageListScrollRegistry 程序化滚动 handle：
 * - handle 报 scrolled → handled:true + acknowledged:true，并做 agentFlash 演出；
 * - message_not_found / view_not_ready / handle 未注册 → 结构化诚实失败；
 * - 冷启动期 handle 未注册时按短重试等待挂载。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- mock sessionManager（register.ts 经动态 import 消费同一路径） ----
vi.mock('@/features/chat/core/session/sessionManager', () => ({
  sessionManager: {
    get: () => undefined,
    getCurrentSessionId: () => null,
    subscribe: () => () => {},
    has: () => false,
  },
}));

// ---- mock agentFlash（避免拉入 CSS，且便于断言演出调用） ----
const agentFlashMock = vi.fn();
vi.mock('../../../agent/visuals/agentFlash', () => ({
  agentFlash: (...args: unknown[]) => agentFlashMock(...args),
}));

import {
  registerChatMessageListScrollHandle,
  type ChatMessageScrollResult,
} from '@/features/chat/components/messageListScrollRegistry';
import { handleChatActivation } from '../register';

const cleanups: Array<() => void> = [];

function registerFakeHandle(
  sessionId: string,
  impl: (messageId: string) => Promise<ChatMessageScrollResult>,
): ReturnType<typeof vi.fn> {
  const scrollToMessage = vi.fn(impl);
  cleanups.push(registerChatMessageListScrollHandle(sessionId, { scrollToMessage }));
  return scrollToMessage;
}

describe('workbench chat scrollToMessage（A45-5）', () => {
  beforeEach(() => {
    agentFlashMock.mockClear();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
    vi.useRealTimers();
  });

  it('handle 报 scrolled → 成功回执 + agentFlash 演出（scroll:false + 窗口作用域）', async () => {
    const root = document.createElement('div');
    root.setAttribute('data-wb-chat-session', 'sess_ok');
    document.body.appendChild(root);

    const scrollFn = registerFakeHandle('sess_ok', async () => ({
      status: 'scrolled',
      element: root,
    }));

    const result = await handleChatActivation({
      windowId: 'w1',
      instanceKey: 'sess_ok',
      action: 'scrollToMessage',
      payload: { messageId: 'msg_42' },
    });

    expect(result).toEqual({ handled: true, acknowledged: true });
    expect(scrollFn).toHaveBeenCalledWith('msg_42');
    expect(agentFlashMock).toHaveBeenCalledWith(
      'chat',
      'msg_42',
      expect.objectContaining({ scroll: false, scope: root }),
    );
  });

  it('虚拟化长会话场景：无需 role="log" 全量子节点即可成功（handle 内部定位）', async () => {
    // 故意不在 DOM 中放任何消息节点——旧实现在此必失败，新实现只依赖 handle
    registerFakeHandle('sess_virtual', async () => ({ status: 'scrolled', element: null }));
    const result = await handleChatActivation({
      windowId: 'w1',
      instanceKey: 'sess_virtual',
      action: 'scrollToMessage',
      payload: { messageId: 'msg_old_120' },
    });
    expect(result).toEqual({ handled: true, acknowledged: true });
  });

  it('messageId 不在会话中 → MESSAGE_NOT_FOUND 诚实失败', async () => {
    vi.useFakeTimers();
    registerFakeHandle('sess_missing', async () => ({ status: 'message_not_found' }));
    const pending = handleChatActivation({
      windowId: 'w1',
      instanceKey: 'sess_missing',
      action: 'scrollToMessage',
      payload: { messageId: 'msg_gone' },
    });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({
      handled: false,
      code: 'MESSAGE_NOT_FOUND',
    });
    expect(agentFlashMock).not.toHaveBeenCalled();
  });

  it('目标行等待挂载超时 → VIEW_NOT_READY', async () => {
    vi.useFakeTimers();
    registerFakeHandle('sess_slow', async () => ({ status: 'view_not_ready' }));
    const pending = handleChatActivation({
      windowId: 'w1',
      instanceKey: 'sess_slow',
      action: 'scrollToMessage',
      payload: { messageId: 'msg_1' },
    });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({
      handled: false,
      code: 'VIEW_NOT_READY',
    });
  });

  it('handle 未注册（列表未挂载）→ WINDOW_NOT_FOUND', async () => {
    vi.useFakeTimers();
    const pending = handleChatActivation({
      windowId: 'w1',
      instanceKey: 'sess_unmounted',
      action: 'scrollToMessage',
      payload: { messageId: 'msg_1' },
    });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({
      handled: false,
      code: 'WINDOW_NOT_FOUND',
    });
  });

  it('冷启动重试：首轮 handle 缺席、重试窗口内挂载后成功', async () => {
    vi.useFakeTimers();
    const pending = handleChatActivation({
      windowId: 'w1',
      instanceKey: 'sess_cold',
      action: 'scrollToMessage',
      payload: { messageId: 'msg_7' },
    });
    // 首轮（delay 0）失败后、第二轮（250ms）前完成挂载注册
    await vi.advanceTimersByTimeAsync(100);
    const scrollFn = registerFakeHandle('sess_cold', async () => ({
      status: 'scrolled',
      element: null,
    }));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ handled: true, acknowledged: true });
    expect(scrollFn).toHaveBeenCalledWith('msg_7');
  });

  it('缺少 messageId → INVALID_ARGS', async () => {
    await expect(handleChatActivation({
      windowId: 'w1',
      instanceKey: 'sess_x',
      action: 'scrollToMessage',
      payload: {},
    })).resolves.toMatchObject({ handled: false, code: 'INVALID_ARGS' });
  });
});
