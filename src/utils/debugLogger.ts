/**
 * 调试日志记录模块
 * 用于追踪RAG内容显示、聊天记录保存、聊天记录串号等关键问题
 */

import { invoke } from '@tauri-apps/api/core';
import { serializeUnknown } from '@/logging/errorReporter';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'TRACE';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  operation: string;
  data: any;
  context?: {
    userId?: string;
    sessionId?: string;
    mistakeId?: string;
    streamId?: string;
    businessId?: string;
  };
  stackTrace?: string;
}

export interface ChatRecordDebugInfo {
  action: 'LOAD' | 'SAVE' | 'DISPLAY' | 'MISMATCH';
  mistakeId: string;
  expectedChatHistory?: any[];
  actualChatHistory?: any[];
  ragSources?: any[];
  thinkingContent?: Map<string, string>;
  streamingState?: any;
}

export interface RAGDebugInfo {
  action: 'QUERY' | 'RESPONSE' | 'DISPLAY' | 'MISSING';
  query?: string;
  sources?: any[];
  displayedSources?: any[];
  expectedCount?: number;
  actualCount?: number;
  ragEnabled?: boolean;
  ragTopK?: number;
}

/** 日志风暴防护配置 */
interface StormProtectionConfig {
  /** 相同错误的去重窗口（毫秒） */
  dedupeWindowMs: number;
  /** 每分钟最大日志数 */
  maxLogsPerMinute: number;
  /** 熔断阈值：每分钟错误数超过此值触发熔断 */
  circuitBreakerThreshold: number;
  /** 熔断冷却时间（毫秒） */
  circuitBreakerCooldownMs: number;
}

const DEFAULT_STORM_PROTECTION: StormProtectionConfig = {
  dedupeWindowMs: 5000,           // 5秒内相同错误只记录一次
  maxLogsPerMinute: 500,          // 每分钟最多500条日志
  circuitBreakerThreshold: 100,   // 每分钟超过100个错误触发熔断
  circuitBreakerCooldownMs: 60000 // 熔断后冷却1分钟
};

class DebugLogger {
  private logQueue: LogEntry[] = [];
  private flushInterval: number | null = null;
  private minuteResetInterval: ReturnType<typeof setInterval> | null = null;
  private maxQueueSize = 100;

  // ===== 日志风暴防护状态 =====
  private stormConfig: StormProtectionConfig = DEFAULT_STORM_PROTECTION;
  /** 错误指纹 -> 最后记录时间 */
  private errorDedupeMap: Map<string, number> = new Map();
  /** 错误指纹 -> 被抑制的次数 */
  private suppressedCountMap: Map<string, number> = new Map();
  /** 当前分钟的日志计数 */
  private logsThisMinute = 0;
  /** 当前分钟的错误计数 */
  private errorsThisMinute = 0;
  /** 分钟计数器重置时间 */
  private minuteResetTime = Date.now();
  /** 熔断器是否打开 */
  private circuitBreakerOpen = false;
  /** 熔断器打开时间 */
  private circuitBreakerOpenTime = 0;
  /** 熔断期间被丢弃的日志数 */
  private droppedDuringCircuitBreaker = 0;

  constructor() {
    if (import.meta.env.MODE === 'test') {
      return;
    }
    this.startAutoFlush();
    this.startMinuteResetTimer();
  }

  /**
   * 记录聊天记录相关的调试信息
   */
  async logChatRecord(
    level: LogLevel,
    operation: string,
    debugInfo: ChatRecordDebugInfo,
    additionalData?: any
  ) {
    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: 'CHAT_RECORD',
      operation,
      data: {
        debugInfo,
        additionalData,
        // 添加详细的聊天记录比较信息
        chatHistoryComparison: debugInfo.action === 'MISMATCH' ? {
          expectedLength: debugInfo.expectedChatHistory?.length || 0,
          actualLength: debugInfo.actualChatHistory?.length || 0,
          firstMismatchIndex: this.findFirstMismatch(
            debugInfo.expectedChatHistory || [],
            debugInfo.actualChatHistory || []
          )
        } : undefined
      },
      context: {
        mistakeId: debugInfo.mistakeId,
        sessionId: this.getCurrentSessionId(),
        businessId: debugInfo.mistakeId
      },
      stackTrace: level === 'ERROR' ? new Error().stack : undefined
    };

    await this.addLog(logEntry);

    // 立即输出严重问题
    if (level === 'ERROR' || debugInfo.action === 'MISMATCH') {
      console.error('🚨 [CHAT_RECORD_CRITICAL]', logEntry);
      await this.flush();
    }
  }

  /**
   * 记录RAG相关的调试信息
   */
  async logRAG(
    level: LogLevel,
    operation: string,
    debugInfo: RAGDebugInfo,
    additionalData?: any
  ) {
    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: 'RAG',
      operation,
      data: {
        debugInfo,
        additionalData,
        // 添加RAG状态检查
        ragStateCheck: {
          ragEnabled: debugInfo.ragEnabled,
          expectedSources: debugInfo.expectedCount || 0,
          actualSources: debugInfo.actualCount || 0,
          missingSourcesCount: (debugInfo.expectedCount || 0) - (debugInfo.actualCount || 0)
        }
      },
      context: {
        sessionId: this.getCurrentSessionId()
      },
      stackTrace: level === 'ERROR' ? new Error().stack : undefined
    };

    await this.addLog(logEntry);

    // 立即输出RAG问题
    if (level === 'ERROR' || debugInfo.action === 'MISSING') {
      console.error('🚨 [RAG_CRITICAL]', logEntry);
      await this.flush();
    }
  }

  /**
   * 记录通用调试信息
   */
  async log(
    level: LogLevel,
    module: string,
    operation: string,
    data: any,
    context?: any
  ) {
    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      operation,
      data,
      context: {
        ...context,
        sessionId: this.getCurrentSessionId()
      },
      stackTrace: level === 'ERROR' ? new Error().stack : undefined
    };

    await this.addLog(logEntry);

    if (level === 'ERROR') {
      const summary =
        typeof data?.message === 'string'
          ? data.message
          : typeof data === 'string'
            ? data
            : operation;
      console.error(`🚨 [${module}_ERROR]`, summary, data);
      await this.flush();
    }
  }

  /**
   * 记录组件状态变化
   */
  async logStateChange(
    component: string,
    operation: string,
    oldState: any,
    newState: any,
    trigger?: string
  ) {
    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'TRACE',
      module: 'STATE_CHANGE',
      operation: `${component}.${operation}`,
      data: {
        component,
        oldState: this.sanitizeState(oldState),
        newState: this.sanitizeState(newState),
        stateDiff: this.calculateStateDiff(oldState, newState),
        trigger
      },
      context: {
        sessionId: this.getCurrentSessionId()
      }
    };

    await this.addLog(logEntry);
  }

  /**
   * 记录流式处理相关信息
   */
  async logStreaming(
    operation: string,
    streamId: string,
    eventType: string,
    payload: any,
    additionalInfo?: any
  ) {
    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'DEBUG',
      module: 'STREAMING',
      operation,
      data: {
        streamId,
        eventType,
        payload: this.sanitizePayload(payload),
        additionalInfo,
        payloadSize: (JSON.stringify(serializeUnknown(payload)) ?? '').length,
      },
      context: {
        streamId,
        sessionId: this.getCurrentSessionId()
      }
    };

    await this.addLog(logEntry);
  }

  /**
   * 记录API调用信息
   */
  async logApiCall(
    operation: string,
    method: string,
    url: string,
    request: any,
    response?: any,
    error?: any,
    duration?: number
  ) {
    const level: LogLevel = error ? 'ERROR' : 'INFO';
    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: 'API',
      operation,
      data: {
        method,
        url,
        request: this.sanitizeRequest(request),
        response: this.sanitizeResponse(response),
        error: error ? {
          message: error.message,
          code: error.code,
          stack: error.stack
        } : undefined,
        duration: duration ? `${duration}ms` : undefined
      },
      context: {
        sessionId: this.getCurrentSessionId()
      },
      stackTrace: error ? new Error().stack : undefined
    };

    await this.addLog(logEntry);

    if (error) {
      console.error('🚨 [API_ERROR]', logEntry);
      await this.flush();
    }
  }

  private async addLog(logEntry: LogEntry) {
    // ===== 日志风暴防护检查 =====
    
    // 1. 检查熔断器状态
    if (this.isCircuitBreakerOpen()) {
      this.droppedDuringCircuitBreaker++;
      return; // 熔断期间丢弃日志
    }

    // 2. 检查限流
    if (this.logsThisMinute >= this.stormConfig.maxLogsPerMinute) {
      // 超过限流阈值，只记录一条警告
      if (this.logsThisMinute === this.stormConfig.maxLogsPerMinute) {
        console.warn(`[debugLogger] 日志限流触发：本分钟已达 ${this.stormConfig.maxLogsPerMinute} 条上限`);
      }
      return;
    }

    // 3. 错误类型日志检查去重
    if (logEntry.level === 'ERROR') {
      const fingerprint = this.getErrorFingerprint(logEntry);
      const now = Date.now();
      const lastLogged = this.errorDedupeMap.get(fingerprint);
      
      if (lastLogged && (now - lastLogged) < this.stormConfig.dedupeWindowMs) {
        // 在去重窗口内，抑制此错误
        const count = (this.suppressedCountMap.get(fingerprint) || 0) + 1;
        this.suppressedCountMap.set(fingerprint, count);
        return;
      }
      
      // 记录此错误，并附加之前被抑制的次数
      this.errorDedupeMap.set(fingerprint, now);
      const suppressedCount = this.suppressedCountMap.get(fingerprint) || 0;
      if (suppressedCount > 0) {
        logEntry.data = {
          ...logEntry.data,
          _suppressedCount: suppressedCount,
          _note: `此错误在过去 ${this.stormConfig.dedupeWindowMs}ms 内被抑制了 ${suppressedCount} 次`
        };
        this.suppressedCountMap.set(fingerprint, 0);
      }
      
      // 更新错误计数，检查是否需要触发熔断
      this.errorsThisMinute++;
      if (this.errorsThisMinute >= this.stormConfig.circuitBreakerThreshold) {
        this.triggerCircuitBreaker();
      }
    }

    // ===== 正常记录日志 =====
    this.logsThisMinute++;
    
    const normalizedEntry: LogEntry = {
      ...logEntry,
      data: serializeUnknown(
        logEntry.data === undefined || logEntry.data === null ? {} : logEntry.data,
      ),
      context: this.normalizeContext(logEntry.context),
    };
    this.logQueue.push(normalizedEntry);
    
    // 队列满了就立即刷新
    if (this.logQueue.length >= this.maxQueueSize) {
      await this.flush();
    }
  }

  private normalizeContext(context: unknown): LogEntry['context'] {
    if (!context || typeof context !== 'object' || Array.isArray(context)) return undefined;
    const value = context as Record<string, unknown>;
    const optionalString = (key: string): string | undefined => {
      const child = value[key];
      if (child === undefined || child === null) return undefined;
      return String(serializeUnknown(child)).slice(0, 256);
    };
    return {
      userId: optionalString('userId'),
      sessionId: optionalString('sessionId'),
      mistakeId: optionalString('mistakeId'),
      streamId: optionalString('streamId'),
      businessId: optionalString('businessId'),
    };
  }

  /** 生成错误指纹用于去重 */
  private getErrorFingerprint(logEntry: LogEntry): string {
    const data = logEntry.data || {};
    let reason = '';
    try {
      reason =
        typeof data.reason === 'object'
          ? JSON.stringify(serializeUnknown(data.reason)).slice(0, 100)
          : String(data.reason || '');
    } catch {
      reason = '[unserializable reason]';
    }
    // 基于错误消息、文件名、行号生成指纹
    const parts = [
      logEntry.module,
      logEntry.operation,
      data.message || '',
      data.filename || '',
      data.lineno || '',
      reason,
    ];
    return parts.join('|');
  }

  /** 检查熔断器是否打开 */
  private isCircuitBreakerOpen(): boolean {
    if (!this.circuitBreakerOpen) return false;
    
    // 检查冷却时间是否已过
    const now = Date.now();
    if (now - this.circuitBreakerOpenTime >= this.stormConfig.circuitBreakerCooldownMs) {
      this.closeCircuitBreaker();
      return false;
    }
    return true;
  }

  /** 触发熔断器 */
  private triggerCircuitBreaker() {
    if (this.circuitBreakerOpen) return;
    
    this.circuitBreakerOpen = true;
    this.circuitBreakerOpenTime = Date.now();
    this.droppedDuringCircuitBreaker = 0;
    
    console.error(
      `🚨 [debugLogger] 熔断器触发！本分钟错误数 ${this.errorsThisMinute} 超过阈值 ${this.stormConfig.circuitBreakerThreshold}，` +
      `暂停日志记录 ${this.stormConfig.circuitBreakerCooldownMs / 1000} 秒`
    );
    
    // 记录一条熔断事件（绕过防护直接加入队列）
    this.logQueue.push({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      module: 'LOGGER',
      operation: 'CIRCUIT_BREAKER_TRIGGERED',
      data: {
        errorsThisMinute: this.errorsThisMinute,
        threshold: this.stormConfig.circuitBreakerThreshold,
        cooldownMs: this.stormConfig.circuitBreakerCooldownMs
      }
    });
  }

  /** 关闭熔断器 */
  private closeCircuitBreaker() {
    console.info(
      `✅ [debugLogger] 熔断器恢复，冷却期间丢弃了 ${this.droppedDuringCircuitBreaker} 条日志`
    );
    
    // 记录恢复事件
    this.logQueue.push({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      module: 'LOGGER',
      operation: 'CIRCUIT_BREAKER_RECOVERED',
      data: {
        droppedCount: this.droppedDuringCircuitBreaker,
        cooldownMs: this.stormConfig.circuitBreakerCooldownMs
      }
    });
    
    this.circuitBreakerOpen = false;
    this.droppedDuringCircuitBreaker = 0;
  }

  /** 启动分钟计数器重置定时器 */
  private startMinuteResetTimer() {
    this.minuteResetInterval = setInterval(() => {
      // 如果有被抑制的错误，输出摘要
      if (this.suppressedCountMap.size > 0) {
        let totalSuppressed = 0;
        this.suppressedCountMap.forEach((count) => {
          totalSuppressed += count;
        });
        if (totalSuppressed > 0) {
          console.info(`[debugLogger] 本分钟共抑制 ${totalSuppressed} 条重复错误`);
        }
        this.suppressedCountMap.clear();
      }
      
      // 清理过期的去重记录
      const now = Date.now();
      this.errorDedupeMap.forEach((timestamp, key) => {
        if (now - timestamp > this.stormConfig.dedupeWindowMs * 2) {
          this.errorDedupeMap.delete(key);
        }
      });
      
      // 重置计数器
      this.logsThisMinute = 0;
      this.errorsThisMinute = 0;
      this.minuteResetTime = now;
    }, 60000); // 每分钟重置
  }

  async flush() {
    if (this.logQueue.length === 0) return;

    const logsToFlush = [...this.logQueue];
    this.logQueue = [];

    try {
      // 调用后端写入日志文件
      await invoke('write_debug_logs', { logs: logsToFlush });
    } catch (error: unknown) {
      // 保留待写队列，下一轮自动重试；不要把可能含用户内容的完整日志回显到 console。
      this.logQueue = [...logsToFlush, ...this.logQueue].slice(-this.maxQueueSize * 5);
      console.warn(`Failed to persist ${logsToFlush.length} debug log entries`, error);
    }
  }

  private startAutoFlush() {
    // 每5秒自动刷新一次日志
    this.flushInterval = window.setInterval(() => {
      void this.flush();
    }, 5000);
  }

  private findFirstMismatch(expected: any[], actual: any[]): number {
    const minLength = Math.min(expected.length, actual.length);
    for (let i = 0; i < minLength; i++) {
      if (JSON.stringify(expected[i]) !== JSON.stringify(actual[i])) {
        return i;
      }
    }
    return expected.length !== actual.length ? minLength : -1;
  }

  private calculateStateDiff(oldState: any, newState: any) {
    if (typeof oldState !== 'object' || typeof newState !== 'object') {
      return { changed: oldState !== newState };
    }

    const changes: any = {};
    const allKeys = new Set([...Object.keys(oldState || {}), ...Object.keys(newState || {})]);
    
    for (const key of allKeys) {
      if (oldState?.[key] !== newState?.[key]) {
        changes[key] = {
          from: oldState?.[key],
          to: newState?.[key]
        };
      }
    }

    return changes;
  }

  private sanitizeState(state: any) {
    if (!state) return state;
    
    // 避免记录过大的状态对象
    const sanitized = { ...state };
    
    // 限制聊天历史长度
    if (sanitized.chatHistory && Array.isArray(sanitized.chatHistory)) {
      if (sanitized.chatHistory.length > 10) {
        sanitized.chatHistory = [
          ...sanitized.chatHistory.slice(0, 5),
          { _truncated: `... ${sanitized.chatHistory.length - 10} items ...` },
          ...sanitized.chatHistory.slice(-5)
        ];
      }
    }

    // 限制思维链内容
    if (sanitized.thinkingContent instanceof Map) {
      sanitized.thinkingContent = Object.fromEntries(sanitized.thinkingContent);
    }

    return sanitized;
  }

  private sanitizePayload(payload: any) {
    if (!payload) return payload;
    const safePayload = serializeUnknown(payload);
    // 限制payload大小
    const str = JSON.stringify(safePayload) ?? String(safePayload);
    if (str.length > 1000) {
      return {
        _truncated: true,
        _originalSize: str.length,
        _preview: str.substring(0, 500) + '...'
      };
    }
    
    return safePayload;
  }

  private sanitizeRequest(request: any) {
    if (!request) return request;
    
    const sanitized = { ...request };
    
    // 移除敏感信息
    if (sanitized.password) sanitized.password = '[REDACTED]';
    if (sanitized.apiKey) sanitized.apiKey = '[REDACTED]';
    if (sanitized.token) sanitized.token = '[REDACTED]';
    
    return sanitized;
  }

  private sanitizeResponse(response: any) {
    return this.sanitizePayload(response);
  }

  private getCurrentSessionId(): string {
    const fallback = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    try {
      const storage =
        typeof globalThis !== 'undefined'
          ? (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage
          : undefined;
      return storage?.getItem('debug-session-id') || fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * 清理资源
   */
  destroy() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (this.minuteResetInterval) {
      clearInterval(this.minuteResetInterval);
      this.minuteResetInterval = null;
    }
    void this.flush();
    
    // 清理风暴防护状态
    this.errorDedupeMap.clear();
    this.suppressedCountMap.clear();
  }

  /**
   * 获取日志系统状态（用于调试）
   */
  getStatus() {
    return {
      queueLength: this.logQueue.length,
      logsThisMinute: this.logsThisMinute,
      errorsThisMinute: this.errorsThisMinute,
      circuitBreakerOpen: this.circuitBreakerOpen,
      droppedDuringCircuitBreaker: this.droppedDuringCircuitBreaker,
      dedupeMapSize: this.errorDedupeMap.size,
      config: this.stormConfig
    };
  }
}

// 导出单例实例
if (typeof window !== 'undefined' && (window as any).__DSTU_DEBUG_LOGGER__) {
  try {
    (window as any).__DSTU_DEBUG_LOGGER__.destroy();
  } catch (error: unknown) {
    console.warn('[debugLogger] 释放旧实例失败', error);
  }
}

export const debugLogger = new DebugLogger();

if (typeof window !== 'undefined') {
  (window as any).__DSTU_DEBUG_LOGGER__ = debugLogger;
  const DEBUG_LOGGER_LIFECYCLE_CLEANUP_KEY = '__DSTU_DEBUG_LOGGER_LIFECYCLE_CLEANUP__';
  const previousCleanup = (window as any)[DEBUG_LOGGER_LIFECYCLE_CLEANUP_KEY] as (() => void) | undefined;
  previousCleanup?.();
  const handleBeforeUnload: EventListener = () => {
    debugLogger.destroy();
  };
  const handlePageHide: EventListener = () => {
    void debugLogger.flush();
  };
  const handleVisibilityChange: EventListener = () => {
    if (document.visibilityState === 'hidden') void debugLogger.flush();
  };
  window.addEventListener('beforeunload', handleBeforeUnload);
  window.addEventListener('pagehide', handlePageHide);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  (window as any)[DEBUG_LOGGER_LIFECYCLE_CLEANUP_KEY] = () => {
    window.removeEventListener('beforeunload', handleBeforeUnload);
    window.removeEventListener('pagehide', handlePageHide);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}

// 便捷方法
export const logChatRecord = debugLogger.logChatRecord.bind(debugLogger);
export const logRAG = debugLogger.logRAG.bind(debugLogger);
export const logStateChange = debugLogger.logStateChange.bind(debugLogger);
export const logStreaming = debugLogger.logStreaming.bind(debugLogger);
export const logApiCall = debugLogger.logApiCall.bind(debugLogger);
export const log = debugLogger.log.bind(debugLogger);
export const getLoggerStatus = debugLogger.getStatus.bind(debugLogger);
