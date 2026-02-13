/**
 * 统一测试快照采集系统
 * 支持UI、Runtime、Invoke、Event、Metrics等多层快照采集
 */

import { getErrorMessage } from './errorUtils';

// ==================== 类型定义 ====================

export type TestRunId = string;

export type SnapshotLayer = 'ui' | 'runtime' | 'invoke' | 'event' | 'metrics';

export interface Snapshot {
  layer: SnapshotLayer;
  ts: number;
  testRunId: TestRunId;
  data: any;
  stepId?: string;
}

export interface UISnapshotData {
  activeElement?: string | null;
  url: string;
  scrollPositions?: Array<{ index: number; visible: boolean }>;
  messageCount?: number;
  visibleMessages?: Array<{ stableId: string; visible: boolean }>;
  inputValue?: string;
  buttonStates?: Record<string, { disabled: boolean; visible: boolean }>;
}

export interface RuntimeSnapshotData {
  phase: string;
  businessId: string;
  streamId?: string;
  messageIndex?: number;
  content?: string;
  thinking?: string;
  state?: any;
  pluginStates?: Record<string, any>;
}

export interface InvokeSnapshotData {
  cmd: string;
  args: any;
  result?: any;
  duration: number;
  error?: string;
  latency?: number;
}

export interface EventSnapshotData {
  event: string;
  detail: any;
  source?: string;
}

export interface MetricsSnapshotData {
  prometheus?: {
    metrics: Record<string, number>;
    timestamp: number;
  };
  queue?: {
    pending: number;
    processing: number;
    completed: number;
  };
  performance?: {
    memory?: number;
    cpu?: number;
  };
}

// ==================== 快照采集器类 ====================

export class SnapshotCollector {
  private snapshots: Snapshot[] = [];
  private testRunId: TestRunId | null = null;
  private eventListeners: Array<{ event: string; handler: (e: Event) => void }> = [];
  private patchCleanups: Array<() => void> = [];

  setTestRunId(id: TestRunId) {
    this.testRunId = id;
  }

  getTestRunId(): TestRunId | null {
    return this.testRunId;
  }

  /**
   * 采集UI层快照
   */
  captureUI(data?: Partial<UISnapshotData>): void {
    if (!this.testRunId) return;

    const snapshot: Snapshot = {
      layer: 'ui',
      ts: Date.now(),
      testRunId: this.testRunId,
      data: {
        activeElement: document.activeElement?.getAttribute('data-testid') || null,
        url: window.location.href,
        scrollPositions: Array.from(document.querySelectorAll('[data-testid^="chat-message"]')).map((el, idx) => ({
          index: idx,
          visible: el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().bottom <= window.innerHeight,
        })),
        messageCount: document.querySelectorAll('[data-testid^="chat-message"]').length,
        visibleMessages: Array.from(document.querySelectorAll('[data-testid^="chat-message"]')).map(el => ({
          stableId: el.getAttribute('data-stable-id') || '',
          visible: el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().bottom <= window.innerHeight,
        })),
        ...data,
      } as UISnapshotData,
    };
    this.snapshots.push(snapshot);
  }

  /**
   * 采集Runtime层快照
   */
  captureRuntime(data: RuntimeSnapshotData): void {
    if (!this.testRunId) return;

    const snapshot: Snapshot = {
      layer: 'runtime',
      ts: Date.now(),
      testRunId: this.testRunId,
      data,
    };
    this.snapshots.push(snapshot);
  }

  /**
   * 采集Invoke层快照
   */
  captureInvoke(data: InvokeSnapshotData): void {
    if (!this.testRunId) return;

    const snapshot: Snapshot = {
      layer: 'invoke',
      ts: Date.now(),
      testRunId: this.testRunId,
      data: {
        ...data,
        args: typeof data.args === 'object' ? JSON.stringify(data.args).substring(0, 500) : String(data.args).substring(0, 500),
        result: data.result ? (typeof data.result === 'object' ? JSON.stringify(data.result).substring(0, 500) : String(data.result).substring(0, 500)) : undefined,
      },
    };
    this.snapshots.push(snapshot);
  }

  /**
   * 采集Event层快照
   */
  captureEvent(data: EventSnapshotData): void {
    if (!this.testRunId) return;

    const snapshot: Snapshot = {
      layer: 'event',
      ts: Date.now(),
      testRunId: this.testRunId,
      data,
    };
    this.snapshots.push(snapshot);
  }

  /**
   * 采集Metrics层快照
   */
  captureMetrics(data: MetricsSnapshotData): void {
    if (!this.testRunId) return;

    const snapshot: Snapshot = {
      layer: 'metrics',
      ts: Date.now(),
      testRunId: this.testRunId,
      data,
    };
    this.snapshots.push(snapshot);
  }

  /**
   * 开始监听运行时事件
   */
  startRuntimeListening(): void {
    if (!this.testRunId) return;

    // 监听流式完成事件
    const streamCompleteHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      this.captureEvent({
        event: 'CHAT_STREAM_COMPLETE',
        detail: detail || {},
        source: 'runtime',
      });
    };

    // 监听保存完成事件
    const saveCompleteHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      this.captureEvent({
        event: 'CHAT_SAVE_COMPLETE',
        detail: detail || {},
        source: 'runtime',
      });
    };

    // 监听流式事件（通过emitDebug的全局事件）
    const streamEventHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.type === 'stream_chunk' || detail?.type === 'stream_thinking') {
        this.captureRuntime({
          phase: detail.type === 'stream_chunk' ? 'streaming' : 'thinking',
          businessId: detail.businessId || '',
          streamId: detail.streamId,
          messageIndex: detail.messageIndex,
          content: detail.content,
          thinking: detail.thinking,
        });
      }
    };

    window.addEventListener('CHAT_STREAM_COMPLETE', streamCompleteHandler);
    window.addEventListener('CHAT_SAVE_COMPLETE', saveCompleteHandler);
    window.addEventListener('DSTU_STREAM_EVENT', streamEventHandler);

    this.eventListeners.push(
      { event: 'CHAT_STREAM_COMPLETE', handler: streamCompleteHandler },
      { event: 'CHAT_SAVE_COMPLETE', handler: saveCompleteHandler },
      { event: 'DSTU_STREAM_EVENT', handler: streamEventHandler }
    );
  }

  /**
   * 开始监听Tauri调用（通过监听 emitDebug 事件）
   */
  startInvokeListening(): void {
    if (!this.testRunId) return;

    // 监听 DSTU_STREAM_EVENT 中的 tauri_invoke 通道
    const invokeEventHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.channel === 'tauri_invoke') {
        const eventName = detail.eventName || '';
        const payload = detail.payload || {};
        
        if (eventName.endsWith(':start')) {
          // 记录开始调用
          const cmd = eventName.replace(':start', '');
          // 暂存调用开始时间
          (this as any).__invokeStarts = (this as any).__invokeStarts || new Map();
          (this as any).__invokeStarts.set(cmd, Date.now());
        } else if (eventName.endsWith(':ok')) {
          // 记录成功调用
          const cmd = eventName.replace(':ok', '');
          const startTime = (this as any).__invokeStarts?.get(cmd) || Date.now();
          const duration = Date.now() - startTime;
          
          this.captureInvoke({
            cmd,
            args: payload.args,
            result: payload.result,
            duration,
            latency: payload.durationMs,
          });
          
          (this as any).__invokeStarts?.delete(cmd);
        } else if (eventName.endsWith(':error')) {
          // 记录失败调用
          const cmd = eventName.replace(':error', '');
          const startTime = (this as any).__invokeStarts?.get(cmd) || Date.now();
          const duration = Date.now() - startTime;
          
          this.captureInvoke({
            cmd,
            args: payload.args,
            error: payload.error,
            duration,
            latency: payload.durationMs,
          });
          
          (this as any).__invokeStarts?.delete(cmd);
        }
      }
    };

    window.addEventListener('DSTU_STREAM_EVENT', invokeEventHandler);
    this.eventListeners.push({ event: 'DSTU_STREAM_EVENT', handler: invokeEventHandler });
  }

  /**
   * 开始监听Metrics（Prometheus指标）
   */
  async startMetricsListening(): Promise<void> {
    if (!this.testRunId) return;

    let metricsFailureCount = 0;
    const MAX_FAILURES = 3; // 连续失败3次后停止采集

    // 定期获取Prometheus指标
    const metricsInterval = setInterval(async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000); // 2秒超时
        
        const resp = await fetch('http://127.0.0.1:59321/metrics', {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        
        if (resp.ok) {
          const text = await resp.text();
          const metrics: Record<string, number> = {};
          
          // 简单解析Prometheus格式
          text.split('\n').forEach(line => {
            if (line && !line.startsWith('#')) {
              const match = line.match(/^(\w+)\s+([\d.]+)/);
              if (match) {
                metrics[match[1]] = parseFloat(match[2]);
              }
            }
          });
          
          this.captureMetrics({
            prometheus: {
              metrics,
              timestamp: Date.now(),
            },
          });
          
          // 重置失败计数
          metricsFailureCount = 0;
        }
      } catch (error: unknown) {
        metricsFailureCount++;
        if (metricsFailureCount >= MAX_FAILURES) {
          clearInterval(metricsInterval);
          console.warn('[TestSnapshot] Prometheus metrics collection stopped after repeated failures');
        }
      }
    }, 5000); // 每5秒采集一次

    this.patchCleanups.push(() => {
      clearInterval(metricsInterval);
    });
  }

  /**
   * 停止所有监听
   */
  stopListening(): void {
    // 移除事件监听器
    this.eventListeners.forEach(({ event, handler }) => {
      window.removeEventListener(event, handler);
    });
    this.eventListeners = [];

    // 还原所有patch
    this.patchCleanups.forEach(cleanup => cleanup());
    this.patchCleanups = [];
  }

  /**
   * 获取所有快照
   */
  getSnapshots(): Snapshot[] {
    return [...this.snapshots];
  }

  /**
   * 获取指定层的快照
   */
  getSnapshotsByLayer(layer: SnapshotLayer): Snapshot[] {
    return this.snapshots.filter(s => s.layer === layer);
  }

  /**
   * 获取指定时间范围的快照
   */
  getSnapshotsByTimeRange(startTime: number, endTime: number): Snapshot[] {
    return this.snapshots.filter(s => s.ts >= startTime && s.ts <= endTime);
  }

  /**
   * 重置快照采集器
   */
  reset(): void {
    this.stopListening();
    this.snapshots = [];
    this.testRunId = null;
  }

  /**
   * 初始化所有监听器
   */
  initialize(testRunId: TestRunId): void {
    this.setTestRunId(testRunId);
    this.startRuntimeListening();
    this.startInvokeListening();
    this.startMetricsListening();
  }
}

// ==================== 导出单例 ====================

export const snapshotCollector = new SnapshotCollector();

