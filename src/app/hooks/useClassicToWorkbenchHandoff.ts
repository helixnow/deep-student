import { useEffect, useRef } from 'react';
import type { CurrentView } from '@/types/navigation';
// P3 handoff（r5 handoff-2 消费侧）：经典壳 → Workbench 切回时复用 bus 打开
// 同一资源。descriptor 形状 { version, appType, resourceId, innerRoute?, savedAt }，
// sanitize 与新鲜度窗口（默认 15min）在模块内完成；consume 总是先删再判，
// 一次即清，不残留跨次交接的陈旧描述符。
import {
  PDF_PAGE_ACTIVATION_TYPE_IDS,
  workbenchBus,
  type PdfPageActivationTypeId,
} from '@/features/workbench/core/workbenchBus';
import { consumeHandoffDescriptor } from '@/features/workbench/core/handoffDescriptor';
import { isMobilePlatform } from '@/utils/platform';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// ★ debugLog 别名：与 App.tsx 相同，console 调用路由到调试面板，受 debugMasterSwitch 控制
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/**
 * P3 handoff 兜底：经典壳视图 → Workbench 应用 typeId。
 * 与 legacyNavigationMap 的 VIEW_BY_TYPE_ID（禁改文件）互为反向；仅收录有明确
 * 对应桌面应用的视图。chat-v2 不进表（需要活跃会话 id，见消费 effect 单独处理）；
 * pdf-reader 等上下文视图的资源状态不在 App 层，
 * 其「同一资源」交接依赖 handoff descriptor 主通道。
 */
export const WORKBENCH_APP_BY_CLASSIC_VIEW: Partial<Record<CurrentView, string>> = {
  'learning-hub': 'files',
  'settings': 'settings',
  'todo': 'todo',
  'skills-management': 'skills',
  'template-management': 'templates',
  'task-dashboard': 'taskDashboard',
  'sandbox-workbench': 'sandbox',
  'flashcards': 'flashcards',
  'media': 'media',
};

/**
 * App 壳层：经典壳 → Workbench 的「同一资源」交接（P3 handoff 消费侧）。会话内
 * workbenchActive 从 false 翻 true 时，优先消费 handoff descriptor，否则按 currentView
 * （chat 活跃会话 / WORKBENCH_APP_BY_CLASSIC_VIEW）兜底，在桌面上重开对应应用。
 * 从 App.tsx 原样搬出。
 */
export function useClassicToWorkbenchHandoff(workbenchActive: boolean, currentView: CurrentView, currentChatHeaderSessionId: string | null) {
  // ★ P3 handoff · 经典壳 → Workbench 消费侧：workbenchMode 在会话内从 false
  //   翻 true（设置页 / 侧边栏开关切回学习桌面）时，复用 workbenchBus 在桌面上
  //   重新打开用户正在使用的资源，保证「同一资源」连续性：
  //   1) 优先消费 handoffDescriptor 的最近交接描述符（读取即消费，一次即清）；
  //   2) 无描述符时按 currentView 推导资源上下文兜底（chat 活跃会话 /
  //      WORKBENCH_APP_BY_CLASSIC_VIEW 页面级应用映射）。
  //   仅处理会话内 false→true 切换——冷启动进桌面走快照恢复链路，不在此重放；
  //   移动平台不启 Workbench：workbenchActive 已含 isMobilePlatform 永真拦截，
  //   下方再显式护栏一次，杜绝 launch 在 bus 未启用时误入 legacy 降级导航。
  //   时序依据：事件路径 persistWorkbenchModeEnabled 在派发 mode-changed 前已
  //   setEnabled(true)；冷启动纠偏路径（localStorage 预读 false → 设置库 true）
  //   由 AgentBridge 的 layoutEffect 在同一次提交先行 setEnabled(true)，本被动
  //   effect 晚于两者。WorkbenchDesktop 稍后挂载时 hydrate 带 preserveExisting，
  //   先行 launch 的窗口不会被快照覆盖。effect 因 currentView / 会话 id 变化的
  //   重跑被 prevRef 短路（wasActive=true），不会重复交接。
  const prevWorkbenchActiveRef = useRef(workbenchActive);
  useEffect(() => {
    const wasActive = prevWorkbenchActiveRef.current;
    prevWorkbenchActiveRef.current = workbenchActive;
    if (wasActive || !workbenchActive || isMobilePlatform()) return;

    // 消费一次即清（模块内先删再判 + 15min 新鲜度窗口）：典型来源是
    // handoffWorkbenchToLegacyShell 在 Workbench→经典壳时落盘的焦点窗上下文，
    // 用户切回学习桌面即恢复到离开时的资源（round-trip 连续性）。
    const handoff = consumeHandoffDescriptor();
    let target: { typeId: string; instanceKey?: string; innerRoute?: string } | null = null;
    if (handoff) {
      target = {
        typeId: handoff.appType,
        // resourceId 可为 null（如焦点曾是 files / 无选中资源的单实例工作区）：
        // 此时仍按「同一应用」交接，仅退化资源级精度
        instanceKey: handoff.resourceId ?? undefined,
        innerRoute: handoff.innerRoute,
      };
    } else if (currentView === 'chat-v2') {
      // 兜底：chat 仅在有活跃会话时交接（避免凭空新建会话窗）
      if (currentChatHeaderSessionId) {
        target = { typeId: 'chat', instanceKey: currentChatHeaderSessionId };
      }
    } else {
      // 其余视图查映射表，无对应桌面应用则静默（空桌面 + Dock 已足够）
      const mapped = WORKBENCH_APP_BY_CLASSIC_VIEW[currentView];
      if (mapped) target = { typeId: mapped };
    }
    const launchTarget = target;
    if (!launchTarget) return;

    // 应用注册在 WorkbenchDesktop chunk 内（registerAll 模块求值即注册）。
    // 经典壳启动（localStorage 预读 false）时该 chunk 未预热，直接 launch 会让
    // note/mindmap 因 notes 工作区未注册落错分支、single 去重与 defaultFrame
    // 拿不到定义——先动态引入补齐注册（与桌面壳挂载命中同一 chunk 家族）再发。
    void (async () => {
      try {
        await import('@/features/workbench/apps/registerAll');
        // 等待期间模式又被关掉：放弃交接，避免 launch 误入 legacy 降级导航
        if (!workbenchBus.isEnabled()) return;
        if (launchTarget.typeId === 'chat' && launchTarget.instanceKey) {
          // chat 走既有入口：聚焦单例 + navigate-to-session 导航握手
          const { openChatSession } = await import('@/features/workbench/apps/chat/newSession');
          openChatSession(launchTarget.instanceKey, 'api');
          return;
        }
        // innerRoute 尽力恢复（descriptor 契约：按前缀识别，不认识则忽略）：
        // page:<n> + PDF 类 typeId → openPdfPage 薄封装（fallbackLaunch 打开
        // 同一资源 + gotoPage ack/超时/stale 防双跳；页跳失败仅降级为资源级交接）
        const pageMatch = launchTarget.innerRoute?.match(/^page:(\d+)$/);
        if (
          pageMatch
          && launchTarget.instanceKey
          && (PDF_PAGE_ACTIVATION_TYPE_IDS as readonly string[]).includes(launchTarget.typeId)
        ) {
          await workbenchBus.openPdfPage({
            typeId: launchTarget.typeId as PdfPageActivationTypeId,
            resourceId: launchTarget.instanceKey,
            page: Number(pageMatch[1]),
          });
          return;
        }
        workbenchBus.launch({
          typeId: launchTarget.typeId,
          instanceKey: launchTarget.instanceKey,
          // 未识别的 innerRoute 以瞬态载荷透传（不进快照），应用侧自行消费
          payload: launchTarget.innerRoute ? { innerRoute: launchTarget.innerRoute } : undefined,
          reason: 'api',
        });
      } catch (error) {
        console.warn('[workbench] classic→workbench handoff failed:', error);
      }
    })();
  }, [workbenchActive, currentView, currentChatHeaderSessionId]);
}
