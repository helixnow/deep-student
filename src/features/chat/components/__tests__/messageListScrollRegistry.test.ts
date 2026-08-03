/**
 * A45-5（docs/dev/acr/ACR-4.5.md）— Chat 消息列表滚动注册表测试
 *
 * 纯注册表生命周期：注册/查询/注销，以及「晚到的注销不误删新 handle」防御
 * （MessageList 会话切换时旧实例的 effect 清理可能晚于新实例注册）。
 */
import { describe, it, expect, vi } from 'vitest';

import {
  getChatMessageListScrollHandle,
  registerChatMessageListScrollHandle,
  type ChatMessageListScrollHandle,
} from '../messageListScrollRegistry';

function makeHandle(): ChatMessageListScrollHandle {
  return { scrollToMessage: vi.fn(async () => ({ status: 'scrolled' as const })) };
}

describe('messageListScrollRegistry（A45-5）', () => {
  it('注册后可按 sessionId 查询，注销后返回 null', () => {
    const handle = makeHandle();
    const dispose = registerChatMessageListScrollHandle('sess_a', handle);
    expect(getChatMessageListScrollHandle('sess_a')).toBe(handle);
    dispose();
    expect(getChatMessageListScrollHandle('sess_a')).toBeNull();
  });

  it('未注册的 sessionId 返回 null', () => {
    expect(getChatMessageListScrollHandle('sess_unknown')).toBeNull();
  });

  it('同 sessionId 重复注册：晚到的旧注销不误删新 handle', () => {
    const first = makeHandle();
    const second = makeHandle();
    const disposeFirst = registerChatMessageListScrollHandle('sess_b', first);
    const disposeSecond = registerChatMessageListScrollHandle('sess_b', second);

    // 旧实例的清理晚到：不得移除新注册的 handle
    disposeFirst();
    expect(getChatMessageListScrollHandle('sess_b')).toBe(second);

    disposeSecond();
    expect(getChatMessageListScrollHandle('sess_b')).toBeNull();
  });

  it('多会话隔离：注销一个不影响另一个', () => {
    const a = makeHandle();
    const b = makeHandle();
    const disposeA = registerChatMessageListScrollHandle('sess_1', a);
    const disposeB = registerChatMessageListScrollHandle('sess_2', b);
    disposeA();
    expect(getChatMessageListScrollHandle('sess_1')).toBeNull();
    expect(getChatMessageListScrollHandle('sess_2')).toBe(b);
    disposeB();
  });
});
