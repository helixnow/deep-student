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
    description:
      '观察和操控内置浏览器会话，支持网址导航、多标签页管理与网页正文提取；网页元素交互由受限 Browser 工具结合 AXTree 语义快照与视觉/坐标兜底完成。',
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
      {
        name: 'newTab',
        description: '在当前浏览器会话中打开新标签页，可选指定初始 URL。',
        inputSchema: objectSchema({ url: { type: 'string', minLength: 1, maxLength: 8192 } }),
        risk: 'medium', mutates: true, reversible: false, idempotent: false,
      },
      {
        name: 'switchTab',
        description: '切换到指定标签页。',
        inputSchema: objectSchema({ tabId: { type: 'string', minLength: 1, maxLength: 256 } }, ['tabId']),
        risk: 'low', mutates: true, reversible: true, idempotent: true,
      },
      {
        name: 'closeTab',
        description: '关闭指定标签页。',
        inputSchema: objectSchema({ tabId: { type: 'string', minLength: 1, maxLength: 256 } }, ['tabId']),
        risk: 'medium', mutates: true, reversible: false, idempotent: false,
      },
      {
        name: 'extractContent',
        description: '提取当前网页的正文 Markdown 内容。',
        inputSchema: objectSchema({
          maxChars: { type: 'integer', minimum: 500, maximum: 40000 },
          startIndex: { type: 'integer', minimum: 0 },
        }),
        risk: 'read', mutates: true, reversible: false, idempotent: true,
      },
    ],
    observe() {
      const state = getBrowserSessionState();
      const history = state.history.slice(-30);
      const hasSession = Boolean(state.sessionId);
      const hasMultipleTabs = state.tabs.length > 1;
      const currentRef = state.currentUrl
        ? stableAgentRef('browser', 'page', state.currentUrl)
        : stableAgentRef('browser', 'session', state.sessionId ?? 'empty');
      return {
        revision: stableRevision(
          state.sessionId,
          state.currentUrl,
          state.title,
          state.historyIndex,
          state.controlMode,
          state.loading,
          state.contentVisible,
          state.error,
          state.activeTabId,
          state.tabs.length,
        ),
        route: state.currentUrl || 'browser/empty',
        mode: state.controlMode,
        busy: state.loading,
        selection: state.currentUrl ? [currentRef] : [],
        availableActions: [
          'navigate',
          ...(state.canGoBack ? ['goBack'] : []),
          ...(state.canGoForward ? ['goForward'] : []),
          ...(state.currentUrl ? ['reload'] : []),
          'focusAddress',
          'takeOver',
          state.contentVisible ? 'hideContent' : 'showContent',
          'newTab',
          ...(hasMultipleTabs ? ['switchTab', 'closeTab'] : []),
          ...(hasSession ? ['extractContent'] : []),
        ],
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
          actions: [
            'navigate',
            'reload',
            state.contentVisible ? 'hideContent' : 'showContent',
            'takeOver',
            ...(hasSession ? ['extractContent'] : []),
          ],
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
          tabs: state.tabs.map((tab) => ({
            tabId: tab.tabId,
            url: tab.url,
            title: tab.title,
            active: tab.active,
          })),
          activeTabId: state.activeTabId,
          tabCount: state.tabs.length,
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
        activeTabId: before.activeTabId,
        tabCount: before.tabs.length,
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
        activeTabId: after.activeTabId,
        tabCount: after.tabs.length,
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
      } else if (action.name === 'switchTab' && typeof args.tabId === 'string') {
        result.postconditions = [{ kind: 'state_equals', path: 'activeTabId', value: args.tabId }];
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
