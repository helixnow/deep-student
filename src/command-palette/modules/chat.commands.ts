/**
 * Chat V2 聊天模块命令
 * 覆盖智能对话的所有核心功能
 */

import i18next from 'i18next';
import {
  MessageSquarePlus,
  Save,
  Square,
  RotateCcw,
  Trash2,
  Copy,
  Share2,
  Download,
  Upload,
  Settings,
  Library,
  Network,
  Globe,
  Wrench,
  Layers,
  BookOpen,
  Bot,
  Zap,
  MessageCircle,
  FileText,
  Image,
  Mic,
  PanelLeftClose,
  PanelRightClose,
  History,
  Bookmark,
  ScanSearch,
} from 'lucide-react';
import type { Command } from '../registry/types';
import { isChatCommandEnabled } from '../registry/capabilityRegistry';

/** Helper: get localized keywords array for a given command key */
const kw = (key: string): string[] =>
  i18next.t(`command_palette:keywords.${key}`, { returnObjects: true, defaultValue: [] }) as string[];

/**
 * Chat V2 模块命令工厂函数
 * 使用 i18next.t() 进行运行时国际化
 *
 * 注：未实现的幽灵命令通过 capabilityRegistry 标记为 hidden，
 * 保留定义以便未来实现。
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
      icon: MessageSquarePlus,
      keywords: kw('chat.new-session'),
      priority: 100,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_NEW_SESSION'));
      },
    },
    {
      id: 'chat.new-analysis-session',
      name: i18next.t('command_palette:commands.chat.new-analysis-session', 'New Question Analysis'),
      description: i18next.t('command_palette:descriptions.chat.new-analysis-session', 'Upload images for OCR recognition and question analysis'),
      category: 'chat',
      shortcut: 'mod+shift+a',
      icon: ScanSearch,
      keywords: kw('chat.new-analysis-session'),
      priority: 99,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_NEW_ANALYSIS_SESSION'));
      },
    },
    {
      id: 'chat.save',
      name: i18next.t('command_palette:commands.chat.save', 'Save Conversation'),
      description: i18next.t('command_palette:descriptions.chat.save', 'Save current conversation to history'),
      category: 'chat',
      shortcut: 'mod+s',
      icon: Save,
      keywords: kw('chat.save'),
      priority: 99,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_SAVE_SESSION'));
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
    {
      id: 'chat.retry',
      name: i18next.t('command_palette:commands.chat.retry', 'Regenerate'),
      description: i18next.t('command_palette:descriptions.chat.retry', 'Regenerate last AI response'),
      category: 'chat',
      shortcut: 'mod+r',
      icon: RotateCcw,
      keywords: kw('chat.retry'),
      priority: 97,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_RETRY_LAST'));
      },
    },
    {
      id: 'chat.clear',
      name: i18next.t('command_palette:commands.chat.clear', 'Clear Conversation'),
      description: i18next.t('command_palette:descriptions.chat.clear', 'Clear current conversation content'),
      category: 'chat',
      icon: Trash2,
      keywords: kw('chat.clear'),
      priority: 80,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_CLEAR_SESSION'));
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
    {
      id: 'chat.share',
      name: i18next.t('command_palette:commands.chat.share', 'Share Conversation'),
      description: i18next.t('command_palette:descriptions.chat.share', 'Generate conversation share link'),
      category: 'chat',
      icon: Share2,
      keywords: kw('chat.share'),
      priority: 84,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_SHARE_SESSION'));
      },
    },
    {
      id: 'chat.export',
      name: i18next.t('command_palette:commands.chat.export', 'Export Conversation'),
      description: i18next.t('command_palette:descriptions.chat.export', 'Export conversation as Markdown or JSON'),
      category: 'chat',
      icon: Download,
      keywords: kw('chat.export'),
      priority: 83,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_EXPORT_SESSION'));
      },
    },
    {
      id: 'chat.import',
      name: i18next.t('command_palette:commands.chat.import', 'Import Conversation'),
      description: i18next.t('command_palette:descriptions.chat.import', 'Import historical conversations from file'),
      category: 'chat',
      icon: Upload,
      keywords: kw('chat.import'),
      priority: 82,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_IMPORT_SESSION'));
      },
    },

    // ==================== 模式切换 ====================
    {
      id: 'chat.toggle-rag',
      name: i18next.t('command_palette:commands.chat.toggle-rag', 'Toggle RAG Mode'),
      description: i18next.t('command_palette:descriptions.chat.toggle-rag', 'Enable/disable retrieval augmentation'),
      category: 'chat',
      shortcut: 'mod+shift+r',
      icon: Library,
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
      icon: Network,
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
    {
      id: 'chat.toggle-learn-mode',
      name: i18next.t('command_palette:commands.chat.toggle-learn-mode', 'Toggle Learning Mode'),
      description: i18next.t('command_palette:descriptions.chat.toggle-learn-mode', 'Enable/disable learning tutor mode'),
      category: 'chat',
      icon: BookOpen,
      keywords: kw('chat.toggle-learn-mode'),
      priority: 86,
      visibleInViews: ['chat-v2'],
      execute: () => {
        // 学习模式已迁移到 Skills 系统，使用 /skill tutor-mode 激活
        console.log('[CommandPalette] Learn mode migrated to skills system. Use /skill tutor-mode');
      },
    },

    // ==================== 模型设置 ====================
    {
      id: 'chat.select-model',
      name: i18next.t('command_palette:commands.chat.select-model', 'Select AI Model'),
      description: i18next.t('command_palette:descriptions.chat.select-model', 'Switch AI model'),
      category: 'chat',
      // shortcut 已移除：mod+shift+m 已分配给 InputBarUI 的 MCP 面板切换
      // 用户可通过命令面板 (Cmd+K) 访问此命令
      icon: Bot,
      keywords: kw('chat.select-model'),
      priority: 75,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_SELECT_MODEL'));
      },
    },
    {
      id: 'chat.model-settings',
      name: i18next.t('command_palette:commands.chat.model-settings', 'Model Settings'),
      description: i18next.t('command_palette:descriptions.chat.model-settings', 'Adjust temperature, token, and other parameters'),
      category: 'chat',
      icon: Settings,
      keywords: kw('chat.model-settings'),
      priority: 74,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_MODEL_SETTINGS'));
      },
    },

    // ==================== 输入增强 ====================
    {
      id: 'chat.upload-image',
      name: i18next.t('command_palette:commands.chat.upload-image', 'Upload Image'),
      description: i18next.t('command_palette:descriptions.chat.upload-image', 'Upload image for analysis'),
      category: 'chat',
      shortcut: 'mod+shift+i',
      icon: Image,
      keywords: kw('chat.upload-image'),
      priority: 70,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_UPLOAD_IMAGE'));
      },
    },
    {
      id: 'chat.upload-file',
      name: i18next.t('command_palette:commands.chat.upload-file', 'Upload File'),
      description: i18next.t('command_palette:descriptions.chat.upload-file', 'Upload document for analysis'),
      category: 'chat',
      icon: FileText,
      keywords: kw('chat.upload-file'),
      priority: 69,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_UPLOAD_FILE'));
      },
    },
    {
      id: 'chat.voice-input',
      name: i18next.t('command_palette:commands.chat.voice-input', 'Voice Input'),
      description: i18next.t('command_palette:descriptions.chat.voice-input', 'Use voice to input messages'),
      category: 'chat',
      icon: Mic,
      keywords: kw('chat.voice-input'),
      priority: 68,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_VOICE_INPUT'));
      },
    },

    // ==================== UI 控制 ====================
    {
      id: 'chat.toggle-sidebar',
      name: i18next.t('command_palette:commands.chat.toggle-sidebar', 'Toggle History Sidebar'),
      description: i18next.t('command_palette:descriptions.chat.toggle-sidebar', 'Show/hide conversation history sidebar'),
      category: 'chat',
      shortcut: 'mod+\\',
      icon: PanelLeftClose,
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
      icon: PanelRightClose,
      keywords: kw('chat.toggle-panel'),
      priority: 59,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_TOGGLE_PANEL'));
      },
    },
    {
      id: 'chat.show-history',
      name: i18next.t('command_palette:commands.chat.show-history', 'View Chat History'),
      description: i18next.t('command_palette:descriptions.chat.show-history', 'Open conversation history list'),
      category: 'chat',
      icon: History,
      keywords: kw('chat.show-history'),
      priority: 58,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_SHOW_HISTORY'));
      },
    },
    {
      id: 'chat.bookmark',
      name: i18next.t('command_palette:commands.chat.bookmark', 'Bookmark Conversation'),
      description: i18next.t('command_palette:descriptions.chat.bookmark', 'Add current conversation to favorites'),
      category: 'chat',
      icon: Bookmark,
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
      icon: Bot,
      keywords: kw('chat.ai-continue'),
      priority: 50,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_AI_CONTINUE'));
      },
    },
    {
      id: 'chat.quick-prompt',
      name: i18next.t('command_palette:commands.chat.quick-prompt', 'Quick Prompt'),
      description: i18next.t('command_palette:descriptions.chat.quick-prompt', 'Use preset prompt templates'),
      category: 'chat',
      shortcut: 'mod+/',
      icon: Zap,
      keywords: kw('chat.quick-prompt'),
      priority: 49,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_QUICK_PROMPT'));
      },
    },
    {
      id: 'chat.multi-turn-edit',
      name: i18next.t('command_palette:commands.chat.multi-turn-edit', 'Edit History Message'),
      description: i18next.t('command_palette:descriptions.chat.multi-turn-edit', 'Edit and regenerate conversation'),
      category: 'chat',
      icon: MessageCircle,
      keywords: kw('chat.multi-turn-edit'),
      priority: 48,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_EDIT_MESSAGE'));
      },
    },
    {
      id: 'chat.branch-conversation',
      name: i18next.t('command_palette:commands.chat.branch-conversation', 'Branch Conversation'),
      description: i18next.t('command_palette:descriptions.chat.branch-conversation', 'Create new conversation branch from current point'),
      category: 'chat',
      icon: Layers,
      keywords: kw('chat.branch-conversation'),
      priority: 47,
      visibleInViews: ['chat-v2'],
      execute: () => {
        window.dispatchEvent(new CustomEvent('CHAT_BRANCH_CONVERSATION'));
      },
    },
  ];
}

/**
 * 通过 capabilityRegistry 过滤后的命令列表。
 * hidden 命令保留定义但不在命令面板中显示。
 */
export function getChatCommands(): Command[] {
  return createRawChatCommands().map((command) => {
    const previousIsEnabled = command.isEnabled;
    return {
      ...command,
      isEnabled: (deps) => {
        if (!isChatCommandEnabled(command.id)) return false;
        return previousIsEnabled ? previousIsEnabled(deps) : true;
      },
    };
  });
}
