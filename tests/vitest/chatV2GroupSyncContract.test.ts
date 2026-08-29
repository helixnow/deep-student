import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 group sync contract', () => {
  it('emits a global group update event after group mutations', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/chat/hooks/useGroupManagement.ts'), 'utf-8');
    const appEvents = readFileSync(resolve(process.cwd(), 'src/events/app.ts'), 'utf-8');

    // 组变更后通过类型化事件中心广播（禁止业务组件手写裸 CustomEvent 字符串）
    expect(source).toContain('dispatchAppEvent(APP_EVENTS.CHAT_GROUPS_UPDATED)');
    // 事件名契约保持不变，跨模块监听方依赖该字符串
    expect(appEvents).toContain("CHAT_GROUPS_UPDATED: 'chat-v2:groups-updated'");
  });

  it('refreshes the modern sidebar when group updates are emitted', () => {
    const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');
    const sessionHookSource = readFileSync(
      resolve(process.cwd(), 'src/features/chat/hooks/useSessionManagement.ts'),
      'utf-8'
    );

    // ModernSidebar 的会话/分组数据来自 useSidebarSessionData，
    // 该 hook 订阅 chat-v2:groups-updated 并去抖刷新
    expect(sidebarSource).toContain('useSidebarSessionData');
    expect(sessionHookSource).toContain("window.addEventListener('chat-v2:groups-updated', scheduleRefresh)");
  });
});
