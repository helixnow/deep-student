import { getBrowserSessionState } from '@/features/browser/sessionStore';
import type {
  ActivationContext,
  ActivationHandlerResult,
  AppAgentManifest,
} from '../../core/types';
import {
  NO_ARGS_SCHEMA,
  actionArgs,
  executeActivation,
  objectSchema,
  shortLabel,
  stableAgentRef,
  stableRevision,
} from '../agentManifestUtils';

export function createBrowserAgentManifest(
  activation: (ctx: ActivationContext) => ActivationHandlerResult | Promise<ActivationHandlerResult>,
): AppAgentManifest {
  return {
    version: 2,
    description: '观察和导航内置浏览器会话。网页元素交互由受限 Browser 工具负责，不开放坐标点击。',
    capabilities: [
      {
        name: 'navigate', description: '导航到公开的 HTTP(S) URL；私网策略仍由浏览器后端强制执行。',
        inputSchema: objectSchema({ url: { type: 'string', minLength: 1, maxLength: 8192 } }, ['url']),
        risk: 'medium', mutates: true, reversible: false, idempotent: false,
      },
      { name: 'goBack', description: '返回浏览历史上一页。', inputSchema: NO_ARGS_SCHEMA, risk: 'low', mutates: true, reversible: false, idempotent: false },
      { name: 'goForward', description: '前进到浏览历史下一页。', inputSchema: NO_ARGS_SCHEMA, risk: 'low', mutates: true, reversible: false, idempotent: false },
      { name: 'reload', description: '重新加载当前页面。', inputSchema: NO_ARGS_SCHEMA, risk: 'medium', mutates: true, reversible: false, idempotent: false },
      { name: 'focusAddress', description: '聚焦浏览器地址栏。', inputSchema: NO_ARGS_SCHEMA, risk: 'read', mutates: true, reversible: false, idempotent: true },
      { name: 'takeOver', description: '把页面控制权立即交还用户。', inputSchema: NO_ARGS_SCHEMA, risk: 'medium', mutates: true, reversible: false, idempotent: true },
      { name: 'showContent', description: '显示浏览器内容窗口。', inputSchema: NO_ARGS_SCHEMA, risk: 'low', mutates: true, reversible: true, idempotent: true },
      { name: 'hideContent', description: '隐藏浏览器内容窗口。', inputSchema: NO_ARGS_SCHEMA, risk: 'low', mutates: true, reversible: true, idempotent: true },
    ],
    observe() {
      const state = getBrowserSessionState();
      const history = state.history.slice(-30);
      const currentRef = state.currentUrl
        ? stableAgentRef('browser', 'page', state.currentUrl)
        : stableAgentRef('browser', 'session', state.sessionId ?? 'empty');
      return {
        revision: stableRevision(state.sessionId, state.currentUrl, state.title, state.historyIndex, state.controlMode, state.loading, state.contentVisible, state.error),
        route: state.currentUrl || 'browser/empty',
        mode: state.controlMode,
        busy: state.loading,
        selection: state.currentUrl ? [currentRef] : [],
        availableActions: ['navigate', ...(state.canGoBack ? ['goBack'] : []), ...(state.canGoForward ? ['goForward'] : []), ...(state.currentUrl ? ['reload'] : []), 'focusAddress', 'takeOver', state.contentVisible ? 'hideContent' : 'showContent'],
        entities: history.map((entry, index) => ({
          ref: stableAgentRef('browser', 'history', entry.seq ?? index, entry.url),
          kind: 'browser-history-entry',
          label: shortLabel(entry.title) ?? shortLabel(entry.url) ?? entry.url,
          description: entry.url,
          actions: ['navigate'],
          state: { url: entry.url, visitedAt: entry.visitedAt ?? null },
        })),
        affordances: state.currentUrl ? [{
          ref: currentRef,
          kind: 'browser-page',
          label: shortLabel(state.title) ?? state.currentUrl,
          description: state.currentUrl,
          actions: ['navigate', 'reload', state.contentVisible ? 'hideContent' : 'showContent', 'takeOver'],
          selected: true,
          value: { url: state.currentUrl },
        }] : [],
        state: {
          sessionId: state.sessionId,
          url: state.currentUrl,
          title: state.title,
          canGoBack: state.canGoBack,
          canGoForward: state.canGoForward,
          historyIndex: state.historyIndex,
          historyLength: state.history.length,
          controlMode: state.controlMode,
          contentVisible: state.contentVisible,
          agentAutomationSupported: state.agentAutomationSupported,
          error: state.error,
        },
      };
    },
    async execute(ctx, action) {
      const before = getBrowserSessionState();
      const snapshot = {
        sessionId: before.sessionId,
        url: before.currentUrl,
        historyIndex: before.historyIndex,
        controlMode: before.controlMode,
        contentVisible: before.contentVisible,
      };
      const result = await executeActivation(activation, ctx, action);
      if (!result.handled) return result;
      const after = getBrowserSessionState();
      result.changed = result.acknowledged === true || stableRevision(snapshot) !== stableRevision({
        sessionId: after.sessionId,
        url: after.currentUrl,
        historyIndex: after.historyIndex,
        controlMode: after.controlMode,
        contentVisible: after.contentVisible,
      });
      if (!result.changed) {
        return {
          handled: false,
          changed: false,
          code: 'ACTION_UNAVAILABLE',
          hint: `${action.name} 未获得浏览器领域或表面确认`,
        };
      }
      const args = actionArgs(action);
      if (action.name === 'navigate' && typeof args.url === 'string') {
        result.entityRefs = [stableAgentRef('browser', 'page', args.url)];
      } else if (action.name === 'takeOver') {
        result.postconditions = [{ kind: 'state_equals', path: 'controlMode', value: 'user' }];
      } else if (action.name === 'showContent' || action.name === 'hideContent') {
        const visible = action.name === 'showContent';
        result.postconditions = [{ kind: 'state_equals', path: 'contentVisible', value: visible }];
        if (result.changed) {
          result.undo = {
            inverse: {
              name: visible ? 'hideContent' : 'showContent',
              expect: [{ kind: 'state_equals', path: 'contentVisible', value: !visible }],
            },
            label: visible ? '隐藏浏览器页面' : '显示浏览器页面',
          };
        }
      }
      return result;
    },
  };
}
