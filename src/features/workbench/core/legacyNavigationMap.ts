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
 */
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { t } from '@/utils/i18n';
import type { ActivateRequest, LaunchRequest } from './types';
import { workbenchBus } from './workbenchBus';
import { requestChatSessionNavigation } from '@/features/chat/navigation/pendingChatNavigation';

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

/** 把 launch/activate 请求翻译为 legacy CustomEvent 导航（导出供测试） */
export function translateLegacyNavigation(
  req: LaunchRequest | ActivateRequest,
  kind: 'launch' | 'activate',
): void {
  const { typeId } = req;
  const instanceKey = 'instanceKey' in req ? req.instanceKey : undefined;

  if (typeId === 'chat') {
    dispatch('NAVIGATE_TO_VIEW', { view: 'chat-v2' });
    if (instanceKey) {
      // ChatV2Page 可能尚未挂载：交给导航握手（就绪立即派发，未就绪挂起待消费）
      requestChatSessionNavigation(instanceKey);
    }
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

  if (RESOURCE_TYPE_IDS.has(typeId)) {
    dispatch('NAVIGATE_TO_VIEW', {
      view: 'learning-hub',
      openResource: instanceKey ? `/${instanceKey}` : undefined,
    });
    return;
  }

  const view = VIEW_BY_TYPE_ID[typeId];
  if (view) {
    dispatch('NAVIGATE_TO_VIEW', { view });
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
