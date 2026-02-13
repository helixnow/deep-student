/**
 * 统一测试追踪系统
 * 为测试运行提供全链路追踪能力，确保日志可关联、可溯源
 */

import { debugMasterSwitch } from '../debug-panel/debugMasterSwitch';

export interface TraceContext {
  testRunId: string;      // 整个测试运行的唯一ID
  scenarioId?: string;    // 当前场景ID
  stepId?: string;        // 当前步骤ID
  timestamp: number;      // 开始时间戳
}

export interface TraceLogEntry {
  traceId: string;
  testRunId: string;
  scenarioId?: string;
  stepId?: string;
  timestamp: number;
  level: 'debug' | 'info' | 'success' | 'warning' | 'error';
  source: string;         // 日志来源：runtime/store/host/save/test
  phase: string;          // 阶段：apply/setState/persist/verify
  message: string;
  data?: any;
  preState?: any;         // 操作前状态
  postState?: any;        // 操作后状态
  duration?: number;      // 耗时（ms）
  errorType?: string;
}

class TestTracer {
  private currentContext: TraceContext | null = null;
  private logs: TraceLogEntry[] = [];
  private listeners: Set<(entry: TraceLogEntry) => void> = new Set();

  /**
   * 开始新的测试运行
   */
  startTestRun(): string {
    const testRunId = `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.currentContext = {
      testRunId,
      timestamp: Date.now(),
    };
    this.logs = [];
    
    this.log('info', 'test', 'init', '🚀 测试运行开始', { testRunId });
    
    return testRunId;
  }

  /**
   * 设置当前场景
   */
  setScenario(scenarioId: string) {
    if (!this.currentContext) return;
    this.currentContext.scenarioId = scenarioId;
    this.log('info', 'test', 'scenario', `📋 场景: ${scenarioId}`);
  }

  /**
   * 设置当前步骤
   */
  setStep(stepId: string) {
    if (!this.currentContext) return;
    this.currentContext.stepId = stepId;
    this.log('info', 'test', 'step', `▶️  步骤: ${stepId}`);
  }

  /**
   * 记录日志
   */
  log(
    level: TraceLogEntry['level'],
    source: string,
    phase: string,
    message: string,
    data?: any,
    preState?: any,
    postState?: any,
    duration?: number,
    errorType?: string
  ) {
    // 检查调试总开关，如果关闭则不输出任何日志
    if (!debugMasterSwitch.isEnabled()) {
      return;
    }

    if (!this.currentContext) {
      // 如果没有活跃的测试上下文，直接输出到console
      console.log(`[${source}.${phase}]`, message, data);
      return;
    }

    const entry: TraceLogEntry = {
      traceId: `${this.currentContext.testRunId}_${this.logs.length}`,
      testRunId: this.currentContext.testRunId,
      scenarioId: this.currentContext.scenarioId,
      stepId: this.currentContext.stepId,
      timestamp: Date.now(),
      level,
      source,
      phase,
      message,
      data,
      preState,
      postState,
      duration,
      errorType,
    };

    this.logs.push(entry);
    
    // 通知所有监听器
    this.listeners.forEach(listener => {
      try {
        listener(entry);
      } catch (error: unknown) {
        console.error('[TestTracer] 监听器执行失败:', error);
      }
    });

    // 同时输出到console，带追踪信息
    const prefix = `[${source}.${phase}][${entry.traceId}]`;
    const logData = { ...data, preState, postState, duration };
    
    switch (level) {
      case 'error':
        console.error(prefix, message, logData);
        break;
      case 'warning':
        console.warn(prefix, message, logData);
        break;
      case 'success':
        console.log(prefix, '✅', message, logData);
        break;
      case 'debug':
        console.debug(prefix, message, logData);
        break;
      default:
        console.log(prefix, message, logData);
    }
  }

  /**
   * 添加日志监听器
   */
  addListener(listener: (entry: TraceLogEntry) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 获取所有日志
   */
  getLogs(): TraceLogEntry[] {
    return [...this.logs];
  }

  /**
   * 获取当前上下文
   */
  getContext(): TraceContext | null {
    return this.currentContext;
  }

  /**
   * 结束测试运行
   */
  endTestRun() {
    if (!this.currentContext) return;
    
    const duration = Date.now() - this.currentContext.timestamp;
    this.log('info', 'test', 'complete', `🏁 测试运行结束`, { 
      duration,
      totalLogs: this.logs.length 
    });
    
    this.currentContext = null;
  }

  /**
   * 导出测试报告
   */
  exportReport(): {
    testRunId: string;
    startTime: number;
    endTime: number;
    duration: number;
    logs: TraceLogEntry[];
    summary: {
      total: number;
      errors: number;
      warnings: number;
      bySource: Record<string, number>;
      byPhase: Record<string, number>;
    };
  } | null {
    if (this.logs.length === 0) return null;

    const startTime = this.logs[0].timestamp;
    const endTime = this.logs[this.logs.length - 1].timestamp;
    
    const summary = {
      total: this.logs.length,
      errors: this.logs.filter(l => l.level === 'error').length,
      warnings: this.logs.filter(l => l.level === 'warning').length,
      bySource: {} as Record<string, number>,
      byPhase: {} as Record<string, number>,
    };

    this.logs.forEach(log => {
      summary.bySource[log.source] = (summary.bySource[log.source] || 0) + 1;
      summary.byPhase[log.phase] = (summary.byPhase[log.phase] || 0) + 1;
    });

    return {
      testRunId: this.logs[0].testRunId,
      startTime,
      endTime,
      duration: endTime - startTime,
      logs: this.logs,
      summary,
    };
  }

  /**
   * 清空日志
   */
  clear() {
    this.logs = [];
    this.currentContext = null;
  }
}

// 全局单例
export const testTracer = new TestTracer();

// 便捷函数
export const traceLog = (
  level: TraceLogEntry['level'],
  source: string,
  phase: string,
  message: string,
  data?: any,
  options?: {
    preState?: any;
    postState?: any;
    duration?: number;
    errorType?: string;
  }
) => {
  testTracer.log(
    level,
    source,
    phase,
    message,
    data,
    options?.preState,
    options?.postState,
    options?.duration,
    options?.errorType
  );
};

