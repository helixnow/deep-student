/**
 * Chat V2 聊天模块命令
 * 覆盖智能对话的所有核心功能
 */

import i18next from 'i18next';
import {
  ChatDots,
  Square,
  Copy,
  Books,
  TreeStructure,
  Globe,
  Wrench,
  Robot,
  SidebarSimple,
  BookmarkSimple,
  MagnifyingGlass,
} from '@phosphor-icons/react';
import type { Command, CommandView, DependencyResolver } from '../registry/types';
import { isChatCommandEnabled } from '../registry/capabilityRegistry';
import { requestChatNewSession } from '@/features/chat/navigation/pendingChatNavigation';

/** Helper: get localized keywords array for a given command key */
const kw = (key: string): string[] =>
  i18next.t(`command_palette:keywords.${key}`, { returnObjects: true, defaultValue: [] }) as string[];

/**
 * Chat V2 模块命令工厂函数
 * 使用 i18next.t() 进行运行时国际化
 *
 * 仅定义已有真实消费者的命令；无监听的幽灵命令不得注册。
 * capabilityRegistry 作为第二道防线，避免能力被回退为 hidden 后仍暴露。
 */
function createRawChatCommands(): Command[] {
  return [
    // ==================== 会话管理 ====================
    {
      id: 'chat.new-session',
      name: i18next.t('command_palette:commands.chat.new-session', 'New Conversation'),
      description: i18next.t('command_palette:descriptions.chat.new-session', 'Start a new AI conversation'),
      category: 'chat',
      shortcut: 'mod+n',
      icon: ChatDots,
      keywords: kw('chat.new-session'),
      priority: 100,
      visibleInViews: ['chat-v2'],
      execute: () => {
        // 经导航握手派发：ChatV2Page 未挂载/未完成初始加载时意图挂起，
        // 挂载就绪后消费（CHAT_NEW_SESSION 事件本身仍照发，供壳层开窗/切视图）。
        requestChatNewSession();
      },
    },
    {
      id: 'chat.new-analysis-session',
      name: i18next.t('command_palette:commands.chat.new-analysis-session', 'New Question Analysis'),
      description: i18next.t('command_palette:descriptions.chat.new-analysis-session', 'Upload images for OCR recognition and question analysis'),
      category: 'chat',
      shortcut: 'mod+shift+a',
      icon: MagnifyingGlass,
      keywords: kw('chat.new-analysis-session'),
      priority: 99,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_NEW_ANALYSIS_SESSION'));
      },
    },
    {
      id: 'chat.stop',
      name: i18next.t('command_palette:commands.chat.stop', 'Stop Generation'),
      description: i18next.t('command_palette:descriptions.chat.stop', 'Stop AI response generation'),
      category: 'chat',
      shortcut: 'mod+.',
      icon: Square,
      keywords: kw('chat.stop'),
      priority: 98,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_STOP_GENERATION'));
      },
    },
    // ==================== 内容操作 ====================
    {
      id: 'chat.copy-last-response',
      name: i18next.t('command_palette:commands.chat.copy-last-response', 'Copy Last Response'),
      description: i18next.t('command_palette:descriptions.chat.copy-last-response', 'Copy last AI response'),
      category: 'chat',
      shortcut: 'mod+shift+c',
      icon: Copy,
      keywords: kw('chat.copy-last-response'),
      priority: 85,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_COPY_LAST_RESPONSE'));
      },
    },
    // ==================== 模式切换 ====================
    {
      id: 'chat.toggle-rag',
      name: i18next.t('command_palette:commands.chat.toggle-rag', 'Toggle RAG Mode'),
      description: i18next.t('command_palette:descriptions.chat.toggle-rag', 'Enable/disable retrieval augmentation'),
      category: 'chat',
      shortcut: 'mod+shift+r',
      icon: Books,
      keywords: kw('chat.toggle-rag'),
      priority: 90,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_TOGGLE_RAG'));
      },
    },
    {
      id: 'chat.toggle-graph',
      name: i18next.t('command_palette:commands.chat.toggle-graph', 'Toggle Graph Mode'),
      description: i18next.t('command_palette:descriptions.chat.toggle-graph', 'Enable/disable knowledge graph query'),
      category: 'chat',
      shortcut: 'mod+shift+g',
      icon: TreeStructure,
      keywords: kw('chat.toggle-graph'),
      priority: 89,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_TOGGLE_GRAPH'));
      },
    },
    {
      id: 'chat.toggle-web-search',
      name: i18next.t('command_palette:commands.chat.toggle-web-search', 'Toggle Web Search'),
      description: i18next.t('command_palette:descriptions.chat.toggle-web-search', 'Enable/disable real-time web search'),
      category: 'chat',
      shortcut: 'mod+shift+w',
      icon: Globe,
      keywords: kw('chat.toggle-web-search'),
      priority: 88,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_TOGGLE_WEB_SEARCH'));
      },
    },
    {
      id: 'chat.toggle-mcp',
      name: i18next.t('command_palette:commands.chat.toggle-mcp', 'Toggle MCP Tools'),
      description: i18next.t('command_palette:descriptions.chat.toggle-mcp', 'Enable/disable MCP tool calling'),
      category: 'chat',
      icon: Wrench,
      keywords: kw('chat.toggle-mcp'),
      priority: 87,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_TOGGLE_MCP'));
      },
    },
    // ==================== UI 控制 ====================
    {
      id: 'chat.toggle-sidebar',
      name: i18next.t('command_palette:commands.chat.toggle-sidebar', 'Toggle History Sidebar'),
      description: i18next.t('command_palette:descriptions.chat.toggle-sidebar', 'Show/hide conversation history sidebar'),
      category: 'chat',
      shortcut: 'mod+\\',
      icon: SidebarSimple,
      keywords: kw('chat.toggle-sidebar'),
      priority: 60,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_TOGGLE_SIDEBAR'));
      },
    },
    {
      id: 'chat.toggle-panel',
      name: i18next.t('command_palette:commands.chat.toggle-panel', 'Toggle Feature Panel'),
      description: i18next.t('command_palette:descriptions.chat.toggle-panel', 'Show/hide right feature panel'),
      category: 'chat',
      shortcut: 'mod+shift+\\',
      icon: SidebarSimple,
      keywords: kw('chat.toggle-panel'),
      priority: 59,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_TOGGLE_PANEL'));
      },
    },
    {
      id: 'chat.bookmark',
      name: i18next.t('command_palette:commands.chat.bookmark', 'Bookmark Conversation'),
      description: i18next.t('command_palette:descriptions.chat.bookmark', 'Add current conversation to favorites'),
      category: 'chat',
      icon: BookmarkSimple,
      keywords: kw('chat.bookmark'),
      priority: 57,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_BOOKMARK_SESSION'));
      },
    },

    // ==================== 高级功能 ====================
    {
      id: 'chat.ai-continue',
      name: i18next.t('command_palette:commands.chat.ai-continue', 'AI Continue'),
      description: i18next.t('command_palette:descriptions.chat.ai-continue', 'Let AI continue current content'),
      category: 'chat',
      shortcut: 'mod+j',
      icon: Robot,
      keywords: kw('chat.ai-continue'),
      priority: 50,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_AI_CONTINUE'));
      },
    },
  ];
}

/**
 * ready 命令在 legacy Chat 页与 Workbench 都可见；
 * Workbench 下要求聚焦窗口是 chat 应用才可执行（范式同 notes.commands.ts）。
 */
const CHAT_READY_COMMAND_VIEWS: CommandView[] = ['chat-v2', 'workbench'];

function isChatCommandContextEnabled(deps: DependencyResolver): boolean {
  const view = deps.getCurrentView();
  return view === 'chat-v2'
    || (view === 'workbench' && deps.getFocusedWorkbenchAppTypeId() === 'chat');
}

/**
 * 通过 capabilityRegistry 过滤后的命令列表。
 * hidden 命令不注册，避免从快捷键设置等直接读取注册表的入口泄漏幽灵命令。
 */
export function getChatCommands(): Command[] {
  return createRawChatCommands()
    .filter((command) => isChatCommandEnabled(command.id))
    .map((command) => {
      const previousIsEnabled = command.isEnabled;
      return {
        ...command,
        visibleInViews: CHAT_READY_COMMAND_VIEWS,
        isEnabled: (deps) => {
          if (!isChatCommandContextEnabled(deps)) return false;
          return previousIsEnabled ? previousIsEnabled(deps) : true;
        },
      };
    });
}
