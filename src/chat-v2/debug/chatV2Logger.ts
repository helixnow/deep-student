/**
 * Chat V2 统一调试日志系统
 * 
 * 覆盖 Chat V2 模块的完整生命周期：
 * - session: 会话管理（创建/加载/切换/销毁）
 * - adapter: 适配器操作（事件监听/发送消息）
 * - event: 事件系统（接收/分发/处理）
 * - message: 消息流程（发送/流式/保存）
 * - block: 块管理（创建/更新/状态）
 * - variant: 变体系统（创建/切换/完成）
 * - thinking: 思维链/推理（开始/流式/完成/错误）
 * - attachment: 附件系统（上传/处理）
 * - mode: 模式系统（切换/状态）
 * - autosave: 自动保存
 * - error: 错误处理
 */

// =============================================================================
// 类型定义
// =============================================================================

/**
 * 日志分类 - 覆盖 Chat V2 所有子系统
 */
export type ChatV2LogCategory =
  | 'session'    // 会话管理
  | 'adapter'    // 适配器
  | 'event'      // 事件系统
  | 'message'    // 消息流程
  | 'block'      // 块管理
  | 'variant'    // 变体系统
  | 'thinking'   // 思维链/推理
  | 'attachment' // 附件系统
  | 'mode'       // 模式系统
  | 'autosave'   // 自动保存
  | 'error';     // 错误处理

/**
 * 日志阶段 - 数据流经过的层级
 */
export type ChatV2LogStage =
  | 'ui'         // UI 组件层
  | 'hook'       // React Hook 层
  | 'store'      // Zustand Store 层
  | 'adapter'    // TauriAdapter 层
  | 'middleware' // 中间件层（eventBridge, chunkBuffer 等）
  | 'backend'    // 后端（仅标记，实际由 Rust 处理）
  | 'poll';      // 轮询层

/**
 * 日志严重程度
 */
export type ChatV2LogSeverity = 'debug' | 'info' | 'warning' | 'error' | 'success';

/**
 * 日志条目
 */
export interface ChatV2LogEntry {
  id: string;
  timestamp: string;
  category: ChatV2LogCategory;
  stage: ChatV2LogStage;
  action: string;
  data: Record<string, unknown>;
  severity: ChatV2LogSeverity;
  /** 会话 ID（可选，用于过滤） */
  sessionId?: string;
  /** 消息 ID（可选，用于追踪） */
  messageId?: string;
  /** 变体 ID（可选，用于追踪） */
  variantId?: string;
}

/**
 * 日志过滤器
 */
export interface ChatV2LogFilter {
  categories?: ChatV2LogCategory[];
  stages?: ChatV2LogStage[];
  severities?: ChatV2LogSeverity[];
  sessionId?: string;
  messageId?: string;
  searchText?: string;
}

// =============================================================================
// 全局日志存储
// =============================================================================

const CHATV2_LOGS: ChatV2LogEntry[] = [];
let LOG_ID_COUNTER = 0;
const MAX_LOGS = 500;

// 事件名称
export const CHATV2_LOG_EVENT = 'CHATV2_LOG_ADDED';
export const CHATV2_LOGS_CLEARED = 'CHATV2_LOGS_CLEARED';

// =============================================================================
// 日志配置（高收益优化：支持生产环境关闭控制台日志）
// =============================================================================

interface ChatV2LogConfig {
  /** 是否输出到控制台（生产环境可关闭） */
  consoleEnabled: boolean;
  /** 仅记录这些严重级别以上的日志到控制台 */
  consoleMinSeverity: ChatV2LogSeverity;
  /** 是否启用日志存储（用于调试面板） */
  storageEnabled: boolean;
}

/** 严重级别优先级 */
const SEVERITY_PRIORITY: Record<ChatV2LogSeverity, number> = {
  debug: 0,
  info: 1,
  success: 2,
  warning: 3,
  error: 4,
};

/** 默认配置 */
const DEFAULT_CONFIG: ChatV2LogConfig = {
  consoleEnabled: import.meta.env.DEV, // 开发模式默认开启，生产模式默认关闭
  consoleMinSeverity: 'info',
  storageEnabled: true,
};

/** 当前配置 */
let logConfig: ChatV2LogConfig = { ...DEFAULT_CONFIG };

/**
 * 配置 Chat V2 日志系统
 * 
 * @example
 * // 生产环境只记录错误
 * configureChatV2Logger({ consoleEnabled: true, consoleMinSeverity: 'error' });
 * 
 * // 完全关闭控制台输出
 * configureChatV2Logger({ consoleEnabled: false });
 */
export function configureChatV2Logger(config: Partial<ChatV2LogConfig>): void {
  logConfig = { ...logConfig, ...config };
  console.log('[ChatV2Logger] Config updated:', logConfig);
}

/**
 * 获取当前日志配置
 */
export function getChatV2LogConfig(): ChatV2LogConfig {
  return { ...logConfig };
}

/**
 * 检查是否应该输出到控制台
 */
function shouldLogToConsole(severity: ChatV2LogSeverity): boolean {
  if (!logConfig.consoleEnabled) return false;
  return SEVERITY_PRIORITY[severity] >= SEVERITY_PRIORITY[logConfig.consoleMinSeverity];
}

// =============================================================================
// 日志函数
// =============================================================================

/**
 * 记录 Chat V2 调试日志
 */
export function logChatV2(
  category: ChatV2LogCategory,
  stage: ChatV2LogStage,
  action: string,
  data: Record<string, unknown> = {},
  severity: ChatV2LogSeverity = 'info',
  context?: {
    sessionId?: string;
    messageId?: string;
    variantId?: string;
  }
): void {
  const entry: ChatV2LogEntry = {
    id: `cv2-${++LOG_ID_COUNTER}`,
    timestamp: new Date().toISOString(),
    category,
    stage,
    action,
    data,
    severity,
    sessionId: context?.sessionId,
    messageId: context?.messageId,
    variantId: context?.variantId,
  };

  // 存储日志（用于调试面板）
  if (logConfig.storageEnabled) {
    CHATV2_LOGS.push(entry);

    // 限制日志数量
    while (CHATV2_LOGS.length > MAX_LOGS) {
      CHATV2_LOGS.shift();
    }
  }

  // 控制台输出（可配置关闭）
  if (shouldLogToConsole(severity)) {
    const prefix = `[ChatV2][${category}][${stage}]`;
    const consoleData = { action, ...data };
    
    switch (severity) {
      case 'error':
        console.error(`❌ ${prefix}`, consoleData);
        break;
      case 'warning':
        console.warn(`⚠️ ${prefix}`, consoleData);
        break;
      case 'success':
        console.log(`✅ ${prefix}`, consoleData);
        break;
      case 'debug':
        console.debug(`🔍 ${prefix}`, consoleData);
        break;
      default:
        console.log(`🔷 ${prefix}`, consoleData);
    }
  }

  // 触发事件通知 UI 更新
  window.dispatchEvent(new CustomEvent(CHATV2_LOG_EVENT, { detail: entry }));
}

/**
 * 清空日志
 */
export function clearChatV2Logs(): void {
  CHATV2_LOGS.length = 0;
  LOG_ID_COUNTER = 0;
  window.dispatchEvent(new CustomEvent(CHATV2_LOGS_CLEARED));
}

/**
 * 获取所有日志
 */
export function getChatV2Logs(): ChatV2LogEntry[] {
  return [...CHATV2_LOGS];
}

/**
 * 获取过滤后的日志
 */
export function getFilteredChatV2Logs(filter: ChatV2LogFilter): ChatV2LogEntry[] {
  return CHATV2_LOGS.filter(log => {
    if (filter.categories?.length && !filter.categories.includes(log.category)) {
      return false;
    }
    if (filter.stages?.length && !filter.stages.includes(log.stage)) {
      return false;
    }
    if (filter.severities?.length && !filter.severities.includes(log.severity)) {
      return false;
    }
    if (filter.sessionId && log.sessionId !== filter.sessionId) {
      return false;
    }
    if (filter.messageId && log.messageId !== filter.messageId) {
      return false;
    }
    if (filter.searchText) {
      const text = filter.searchText.toLowerCase();
      const actionMatch = log.action.toLowerCase().includes(text);
      const dataMatch = JSON.stringify(log.data).toLowerCase().includes(text);
      if (!actionMatch && !dataMatch) {
        return false;
      }
    }
    return true;
  });
}

// =============================================================================
// 便捷日志函数（按分类）
// =============================================================================

/** 会话管理日志 */
export const logSession = (
  stage: ChatV2LogStage,
  action: string,
  data?: Record<string, unknown>,
  severity?: ChatV2LogSeverity,
  sessionId?: string
) => logChatV2('session', stage, action, data, severity, { sessionId });

/** 适配器日志 */
export const logAdapter = (
  stage: ChatV2LogStage,
  action: string,
  data?: Record<string, unknown>,
  severity?: ChatV2LogSeverity,
  context?: { sessionId?: string; messageId?: string }
) => logChatV2('adapter', stage, action, data, severity, context);

/** 事件系统日志 */
export const logEvent = (
  stage: ChatV2LogStage,
  action: string,
  data?: Record<string, unknown>,
  severity?: ChatV2LogSeverity,
  context?: { sessionId?: string; messageId?: string; variantId?: string }
) => logChatV2('event', stage, action, data, severity, context);

/** 消息流程日志 */
export const logMessage = (
  stage: ChatV2LogStage,
  action: string,
  data?: Record<string, unknown>,
  severity?: ChatV2LogSeverity,
  context?: { sessionId?: string; messageId?: string }
) => logChatV2('message', stage, action, data, severity, context);

/** 块管理日志 */
export const logBlock = (
  stage: ChatV2LogStage,
  action: string,
  data?: Record<string, unknown>,
  severity?: ChatV2LogSeverity,
  context?: { sessionId?: string; messageId?: string; variantId?: string }
) => logChatV2('block', stage, action, data, severity, context);

/** 变体系统日志 */
export const logVariant = (
  stage: ChatV2LogStage,
  action: string,
  data?: Record<string, unknown>,
  severity?: ChatV2LogSeverity,
  context?: { sessionId?: string; messageId?: string; variantId?: string }
) => logChatV2('variant', stage, action, data, severity, context);

/** 附件系统日志 */
export const logAttachment = (
  stage: ChatV2LogStage,
  action: string,
  data?: Record<string, unknown>,
  severity?: ChatV2LogSeverity,
  context?: { sessionId?: string; messageId?: string }
) => logChatV2('attachment', stage, action, data, severity, context);

/** 模式系统日志 */
export const logMode = (
  stage: ChatV2LogStage,
  action: string,
  data?: Record<string, unknown>,
  severity?: ChatV2LogSeverity,
  sessionId?: string
) => logChatV2('mode', stage, action, data, severity, { sessionId });

/** 自动保存日志 */
export const logAutosave = (
  stage: ChatV2LogStage,
  action: string,
  data?: Record<string, unknown>,
  severity?: ChatV2LogSeverity,
  sessionId?: string
) => logChatV2('autosave', stage, action, data, severity, { sessionId });

/** 错误日志 */
export const logError = (
  stage: ChatV2LogStage,
  action: string,
  data?: Record<string, unknown>,
  context?: { sessionId?: string; messageId?: string; variantId?: string }
) => logChatV2('error', stage, action, data, 'error', context);

// =============================================================================
// 全局注入（兼容旧的 __multiVariantDebug）
// =============================================================================

function injectChatV2Debug() {
  (window as any).__chatV2Debug = {
    // 日志函数
    log: logChatV2,
    logSession,
    logAdapter,
    logEvent,
    logMessage,
    logBlock,
    logVariant,
    logAttachment,
    logMode,
    logAutosave,
    logError,
    // 日志管理
    clear: clearChatV2Logs,
    getLogs: getChatV2Logs,
    getFilteredLogs: getFilteredChatV2Logs,
    // 🆕 配置函数（支持运行时动态配置）
    configure: configureChatV2Logger,
    getConfig: getChatV2LogConfig,
    // 便捷方法
    enableConsole: () => configureChatV2Logger({ consoleEnabled: true }),
    disableConsole: () => configureChatV2Logger({ consoleEnabled: false }),
    setMinSeverity: (severity: ChatV2LogSeverity) => 
      configureChatV2Logger({ consoleMinSeverity: severity }),
  };

  // 兼容旧的 __multiVariantDebug API
  (window as any).__multiVariantDebug = {
    log: (
      stage: 'chip' | 'hook' | 'store' | 'adapter' | 'backend',
      action: string,
      data: Record<string, unknown>,
      severity: 'info' | 'warning' | 'error' | 'success' = 'info'
    ) => {
      // 映射旧的 stage 到新的系统
      const mappedStage: ChatV2LogStage = 
        stage === 'chip' ? 'ui' :
        stage === 'hook' ? 'hook' :
        stage === 'store' ? 'store' :
        stage === 'adapter' ? 'adapter' :
        'backend';
      
      // 根据 action 判断分类
      let category: ChatV2LogCategory = 'variant';
      if (action.includes('Session') || action.includes('session')) {
        category = 'session';
      } else if (action.includes('Block') || action.includes('block')) {
        category = 'block';
      } else if (action.includes('Message') || action.includes('message')) {
        category = 'message';
      }
      
      logChatV2(category, mappedStage, action, data, severity);
    },
    clear: clearChatV2Logs,
    getLogs: getChatV2Logs,
  };
}

// 立即注入
injectChatV2Debug();

// =============================================================================
// 导出统计信息
// =============================================================================

export function getChatV2LogStats(): {
  total: number;
  byCategory: Record<ChatV2LogCategory, number>;
  byStage: Record<ChatV2LogStage, number>;
  bySeverity: Record<ChatV2LogSeverity, number>;
} {
  const byCategory: Record<ChatV2LogCategory, number> = {
    session: 0,
    adapter: 0,
    event: 0,
    message: 0,
    block: 0,
    variant: 0,
    thinking: 0,
    attachment: 0,
    mode: 0,
    autosave: 0,
    error: 0,
  };

  const byStage: Record<ChatV2LogStage, number> = {
    ui: 0,
    hook: 0,
    store: 0,
    adapter: 0,
    middleware: 0,
    backend: 0,
    poll: 0,
  };

  const bySeverity: Record<ChatV2LogSeverity, number> = {
    debug: 0,
    info: 0,
    warning: 0,
    error: 0,
    success: 0,
  };

  for (const log of CHATV2_LOGS) {
    byCategory[log.category]++;
    byStage[log.stage]++;
    bySeverity[log.severity]++;
  }

  return {
    total: CHATV2_LOGS.length,
    byCategory,
    byStage,
    bySeverity,
  };
}
