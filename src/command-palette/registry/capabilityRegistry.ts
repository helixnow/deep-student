/**
 * Capability registry for command visibility.
 *
 * Rule: commands shown in palette should be executable in current build.
 */

export type CapabilityState = 'ready' | 'experimental' | 'hidden';

/**
 * Learning Hub：仅列出可执行命令。未知 id 默认 hidden。
 * 无消费者的 stub 已从 learning.commands.ts 删除（2026-07-20）。
 */
const LEARNING_CAPABILITIES: Readonly<Record<string, CapabilityState>> = {
  'learning.translate': 'ready',
  'learning.essay-grading': 'ready',
  'learning.grade-essay': 'ready',
  'learning.essay-suggestions': 'ready',
};

export const getLearningCapability = (commandId: string): CapabilityState => {
  return LEARNING_CAPABILITIES[commandId] ?? 'hidden';
};

export const isLearningCommandEnabled = (commandId: string): boolean => {
  const state = getLearningCapability(commandId);
  return state === 'ready' || state === 'experimental';
};

// ==================== Chat V2 Capabilities ====================

const CHAT_CAPABILITIES: Readonly<Record<string, CapabilityState>> = {
  // 会话管理 — 已有监听
  'chat.new-session': 'ready',
  'chat.new-analysis-session': 'ready',
  'chat.save': 'ready',
  'chat.stop': 'ready',
  'chat.retry': 'ready',
  'chat.clear': 'ready',

  // 内容操作
  // copy-last-response：useChatPageEvents 已补 CHAT_COPY_LAST_RESPONSE 监听
  'chat.copy-last-response': 'ready',
  'chat.share': 'hidden',
  'chat.export': 'hidden',
  'chat.import': 'hidden',

  // 模式切换 — 已有监听
  'chat.toggle-rag': 'ready',
  'chat.toggle-graph': 'ready',
  'chat.toggle-web-search': 'ready',
  'chat.toggle-mcp': 'ready',
  // 学习模式 — 空壳，隐藏
  'chat.toggle-learn-mode': 'hidden',

  // 模型设置
  'chat.select-model': 'ready',
  'chat.model-settings': 'hidden',

  // 输入增强
  'chat.upload-image': 'ready',
  'chat.upload-file': 'ready',
  'chat.voice-input': 'hidden',

  // UI 控制
  'chat.toggle-sidebar': 'ready',
  'chat.toggle-panel': 'ready',
  'chat.show-history': 'hidden',
  'chat.bookmark': 'ready',

  // 高级功能
  // ai-continue：useChatPageEvents 已补 CHAT_AI_CONTINUE 监听（continueMessage 链路）
  'chat.ai-continue': 'ready',
  'chat.quick-prompt': 'hidden',
  'chat.multi-turn-edit': 'hidden',
  'chat.branch-conversation': 'hidden',
};

export const getChatCapability = (commandId: string): CapabilityState => {
  return CHAT_CAPABILITIES[commandId] ?? 'hidden';
};

export const isChatCommandEnabled = (commandId: string): boolean => {
  const state = getChatCapability(commandId);
  return state === 'ready' || state === 'experimental';
};

// ==================== Global Capabilities ====================

const GLOBAL_CAPABILITIES: Readonly<Record<string, CapabilityState>> = {
  // 命令面板 — 核心功能
  'global.command-palette': 'ready',

  // 搜索 — 无监听，隐藏
  'global.quick-search': 'hidden',

  // 快捷键设置 — 无监听，隐藏
  'global.shortcut-settings': 'hidden',

  // 应用控制 — 已有实际逻辑
  'global.reload': 'ready',
  'global.toggle-fullscreen': 'ready',

  // 缩放控制 — 已有实际逻辑
  'global.zoom-in': 'ready',
  'global.zoom-out': 'ready',
  'global.zoom-reset': 'ready',

  // 主题切换 — 已有实际逻辑（通过 deps）
  'global.toggle-theme': 'ready',
  'global.theme-light': 'ready',
  'global.theme-dark': 'ready',
  // 跟随系统主题 — 无监听，隐藏
  'global.theme-system': 'hidden',

  // 通知控制 — 无监听，隐藏
  'global.toggle-notifications': 'hidden',
  'global.mute-sounds': 'hidden',

  // 网络与同步 — 无监听，隐藏
  'global.check-connection': 'hidden',
  'global.sync-now': 'hidden',

  // 剪贴板操作
  'global.copy-current-url': 'ready',
  'global.paste-from-clipboard': 'hidden',

  // 帮助与信息 — 无监听，隐藏
  'global.show-help': 'hidden',
  'global.about': 'hidden',
  'global.changelog': 'hidden',
  'global.report-bug': 'hidden',

  // 数据操作 — 无监听，隐藏
  'global.export-all': 'hidden',
  'global.import-data': 'hidden',

  // 锁定 — 无监听，隐藏
  'global.lock-app': 'hidden',

  // 状态指示 — 无监听，隐藏
  'global.show-loading': 'hidden',
};

export const getGlobalCapability = (commandId: string): CapabilityState => {
  return GLOBAL_CAPABILITIES[commandId] ?? 'hidden';
};

export const isGlobalCommandEnabled = (commandId: string): boolean => {
  const state = getGlobalCapability(commandId);
  return state === 'ready' || state === 'experimental';
};
