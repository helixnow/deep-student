/**
 * legacyNavigationMap（P11）— workbench 关闭时的导航降级映射
 *
 * 业务模块调用 workbenchBus.launch / activate 时，若实验开关关闭，
 * bus 会把请求交给这里翻译回现有 CustomEvent 导航（设计 §9.3：
 * 调用方无感知，legacy 路径 100% 复用现有 App.tsx / 页面监听链路）。
 *
 * 本模块保持轻依赖（types、workbenchBus、导航握手模块，以及启动期已在 App
 * 依赖图中的 showGlobalNotification / i18n 工具），App.tsx 启动时深路径引入
 * 并 install，一次注册全局生效。
 *
 * 映射表（typeId → legacy 行为）：
 * - chat                → NAVIGATE_TO_VIEW chat-v2 (+ navigate-to-session / CHAT_V2_SET_INPUT)
 * - note/textbook/exam/translation/essay/image/file/mindmap（资源 typeId）
 *   与 file-preview（OS 统一预览壳）
 *                       → NAVIGATE_TO_VIEW learning-hub + openResource=/{resourceId}
 * - files / notes       → NAVIGATE_TO_VIEW learning-hub（notes 工作区是 OS 专属壳，
 *                         legacy 下资源仍在资源库中打开）
 * - settings/todo/skills/templates/taskDashboard/sandbox → NAVIGATE_TO_VIEW 对应视图
 * - pomodoro             → 显式 no-op（GlobalPomodoroWidget 常驻，静默即可）
 * - browser / flashcards → no-op + 全局通知「仅桌面端可用」（OS 模式专属，
 *                         legacy 无对应页面，静默会让用户以为点击无效）
 *
 * 0824 Wave2-B r5（接缝三 handoff）：除「新请求降级」外，本模块另提供
 * Workbench→经典壳的**焦点上下文交接** handoffWorkbenchToLegacyShell——
 * 采集焦点窗 descriptor（handoffDescriptor.ts）落独立 settings key，并复用
 * 同一张映射表把经典壳 CurrentView 对齐到焦点窗，而不是让用户落回与
 * Workbench 无关的旧视图。innerRoute（tab/page）经存储的 descriptor 由
 * 经典壳侧消费（App.tsx，r5 handoff-2 辖区），本模块不派发新事件协议。
 */
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { t } from '@/utils/i18n';
import type { ActivateRequest, LaunchRequest } from './types';
import { workbenchBus } from './workbenchBus';
import { requestChatSessionNavigation } from '@/features/chat/navigation/pendingChatNavigation';
import {
  collectFocusHandoffDescriptor,
  saveHandoffDescriptor,
  type WorkbenchHandoffDescriptor,
} from './handoffDescriptor';

const RESOURCE_TYPE_IDS = new Set([
  'note',
  'textbook',
  'exam',
  'translation',
  'essay',
  'image',
  'file',
  'mindmap',
  // OS 统一预览壳：instanceKey 即资源 id，legacy 同样进资源库打开
  'file-preview',
]);

const VIEW_BY_TYPE_ID: Record<string, string> = {
  chat: 'chat-v2',
  files: 'learning-hub',
  // OS notes 工作区（应用 typeId）：legacy 无对应工作区页，落资源库
  notes: 'learning-hub',
  settings: 'settings',
  todo: 'todo',
  skills: 'skills-management',
  templates: 'template-management',
  taskDashboard: 'task-dashboard',
  sandbox: 'sandbox-workbench',
};

/** 有意 no-op 的 typeId：legacy 壳没有对应页面，不做导航也不 warn。
 * pomodoro 静默（GlobalPomodoroWidget 常驻 legacy 壳）；browser / flashcards
 * 为 OS 模式专属应用，no-op 时给一条「仅桌面端可用」的全局通知。 */
const LEGACY_NOOP_TYPE_IDS = new Set(['pomodoro', 'browser', 'flashcards']);

function dispatch(name: string, detail?: unknown): void {
  try {
    window.dispatchEvent(new CustomEvent(name, detail !== undefined ? { detail } : undefined));
  } catch {
    /* 测试环境无 window 时忽略 */
  }
}

/** 视图切换后延迟派发页面级事件（等 React 渲染，节奏与 App.tsx 现有链路一致） */
function dispatchDeferred(name: string, detail: unknown, delay = 150): void {
  window.setTimeout(() => dispatch(name, detail), delay);
}

/** 该 typeId 在经典壳是否有可落地的视图（chat / 资源类 / 显式视图映射） */
function hasLegacyViewMapping(typeId: string): boolean {
  return typeId === 'chat' || RESOURCE_TYPE_IDS.has(typeId) || Boolean(VIEW_BY_TYPE_ID[typeId]);
}

/**
 * 共享派发核心：按 typeId + 资源 id 把经典壳导航到对应视图。
 * 「新请求降级」（translateLegacyNavigation）与「焦点交接」
 * （handoffWorkbenchToLegacyShell）复用同一张映射表，零新导航协议。
 * 返回是否命中映射（no-op / 未知 typeId → false，不派发任何事件）。
 */
function dispatchLegacyViewNavigation(typeId: string, resourceId: string | null): boolean {
  if (typeId === 'chat') {
    dispatch('NAVIGATE_TO_VIEW', { view: 'chat-v2' });
    if (resourceId) {
      // ChatV2Page 可能尚未挂载：交给导航握手（就绪立即派发，未就绪挂起待消费）
      requestChatSessionNavigation(resourceId);
    }
    return true;
  }
  if (RESOURCE_TYPE_IDS.has(typeId)) {
    dispatch('NAVIGATE_TO_VIEW', {
      view: 'learning-hub',
      openResource: resourceId ? `/${resourceId}` : undefined,
    });
    return true;
  }
  const view = VIEW_BY_TYPE_ID[typeId];
  if (view) {
    dispatch('NAVIGATE_TO_VIEW', { view });
    return true;
  }
  return false;
}

/** 把 launch/activate 请求翻译为 legacy CustomEvent 导航（导出供测试） */
export function translateLegacyNavigation(
  req: LaunchRequest | ActivateRequest,
  kind: 'launch' | 'activate',
): void {
  const { typeId } = req;
  const instanceKey = 'instanceKey' in req ? req.instanceKey : undefined;

  if (typeId === 'chat') {
    dispatchLegacyViewNavigation('chat', instanceKey ?? null);
    if (kind === 'activate') {
      const activate = req as ActivateRequest;
      if (activate.action === 'setInput') {
        const payload = activate.payload;
        const content =
          typeof payload === 'string'
            ? payload
            : payload && typeof payload === 'object'
              ? (payload as { content?: string }).content
              : undefined;
        if (content) dispatchDeferred('CHAT_V2_SET_INPUT', { content }, 300);
      }
      // focusInput / scrollToMessage：legacy 页面自行处理焦点，切换会话已足够
    }
    return;
  }

  if (dispatchLegacyViewNavigation(typeId, instanceKey ?? null)) {
    return;
  }

  if (LEGACY_NOOP_TYPE_IDS.has(typeId)) {
    // pomodoro 例外：GlobalPomodoroWidget 常驻 legacy 壳，无需提示
    if (typeId !== 'pomodoro') {
      showGlobalNotification(
        'info',
        t(
          'legacyFallback.desktopOnly',
          { name: t(`apps.${typeId}`, undefined, 'workbench') },
          'workbench',
        ),
      );
    }
    return;
  }

  console.warn('[workbench] legacy fallback has no mapping for typeId:', typeId);
}

let installed = false;

/** App 启动时调用一次（幂等）：注册 bus 的 legacy 降级 handler */
export function installLegacyNavigationFallback(): void {
  if (installed) return;
  installed = true;
  workbenchBus.registerLegacyFallback(translateLegacyNavigation);
}

/**
 * Workbench→经典壳的焦点上下文交接（接缝三 · r5 handoff-1）。
 *
 * 与 translateLegacyNavigation 的分工：后者处理停用后的**新** launch/activate
 * 请求；本函数处理停用**时刻**已打开焦点窗的迁移——不只改 CurrentView，
 * 还把 { appType, resourceId, innerRoute } 落独立 settings key，供经典壳侧
 * 消费一次即清（innerRoute 的应用归 App.tsx / 页面层，r5 handoff-2 辖区）。
 *
 * 调用点约定（本轮不接线，App.tsx 为 handoff-2 独占）：应在停用事务
 * （runWorkbenchDeactivationTransaction）返回 ok 之后、workbenchActive
 * 翻 false / 卸载 LazyWorkbenchDesktop 之前同步调用——此时窗口尚未卸载，
 * 焦点窗与单实例工作区注册表仍在，采集结果完整。
 *
 * 行为：
 * 1. 无焦点窗（空桌面/全最小化）→ null，经典壳保持原 currentView；
 * 2. 焦点窗为 OS 专属应用（browser/flashcards/pomodoro 等无经典壳视图）
 *    → null，不落 descriptor 也不弹「仅桌面端可用」——壳切换不是点击，
 *    提示只会制造噪音；
 * 3. 命中映射 → 先落盘 descriptor（storage 失败不阻塞，资源级导航仍继续），
 *    再复用共享映射把 CurrentView 对齐到焦点窗（资源类 → learning-hub +
 *    openResource；chat → chat-v2 + 会话握手；视图类 → 对应 view）。
 *
 * 返回实际交接的 descriptor（落盘失败时为内存值），供调用方记录/测试断言。
 */
export function handoffWorkbenchToLegacyShell(): WorkbenchHandoffDescriptor | null {
  const collected = collectFocusHandoffDescriptor();
  if (!collected) return null;
  if (!hasLegacyViewMapping(collected.appType)) return null;
  const persisted = saveHandoffDescriptor(collected);
  dispatchLegacyViewNavigation(collected.appType, collected.resourceId);
  return persisted ?? collected;
}
