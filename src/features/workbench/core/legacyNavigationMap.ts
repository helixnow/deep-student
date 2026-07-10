/**
 * legacyNavigationMap（P11）— workbench 关闭时的导航降级映射
 *
 * 业务模块调用 workbenchBus.launch / activate 时，若实验开关关闭，
 * bus 会把请求交给这里翻译回现有 CustomEvent 导航（设计 §9.3：
 * 调用方无感知，legacy 路径 100% 复用现有 App.tsx / 页面监听链路）。
 *
 * 本模块保持零重依赖（只 import types 与 workbenchBus），
 * App.tsx 启动时深路径引入并 install，一次注册全局生效。
 *
 * 映射表（typeId → legacy 行为）：
 * - chat                → NAVIGATE_TO_VIEW chat-v2 (+ navigate-to-session / CHAT_V2_SET_INPUT)
 * - note/textbook/exam/translation/essay/image/file/mindmap
 *                       → NAVIGATE_TO_VIEW learning-hub + openResource=/{resourceId}
 * - files               → NAVIGATE_TO_VIEW learning-hub
 * - settings/todo/skills/templates/taskDashboard/sandbox → NAVIGATE_TO_VIEW 对应视图
 * - pomodoro            → no-op（GlobalPomodoroWidget 常驻，无对应页面）
 */
import type { ActivateRequest, LaunchRequest } from './types';
import { workbenchBus } from './workbenchBus';

const RESOURCE_TYPE_IDS = new Set([
  'note',
  'textbook',
  'exam',
  'translation',
  'essay',
  'image',
  'file',
  'mindmap',
]);

const VIEW_BY_TYPE_ID: Record<string, string> = {
  chat: 'chat-v2',
  files: 'learning-hub',
  settings: 'settings',
  todo: 'todo',
  skills: 'skills-management',
  templates: 'template-management',
  taskDashboard: 'task-dashboard',
  sandbox: 'sandbox-workbench',
};

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
      // ChatV2Page 可能尚未挂载，按命令面板同款节奏多次派发（setCurrentSessionId 幂等）
      dispatchDeferred('navigate-to-session', { sessionId: instanceKey }, 0);
      dispatchDeferred('navigate-to-session', { sessionId: instanceKey }, 400);
      dispatchDeferred('navigate-to-session', { sessionId: instanceKey }, 1200);
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

  console.warn('[workbench] legacy fallback has no mapping for typeId:', typeId);
}

let installed = false;

/** App 启动时调用一次（幂等）：注册 bus 的 legacy 降级 handler */
export function installLegacyNavigationFallback(): void {
  if (installed) return;
  installed = true;
  workbenchBus.registerLegacyFallback(translateLegacyNavigation);
}
