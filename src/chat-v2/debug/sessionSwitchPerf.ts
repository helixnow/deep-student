/**
 * 会话切换性能追踪器
 * 
 * 记录会话切换各阶段的耗时，用于性能分析和瓶颈定位。
 * 
 * ## 打点阶段
 * 1. click_switch       - 用户点击切换会话
 * 2. store_get_or_create - SessionManager.getOrCreate 获取/创建 Store
 * 3. adapter_setup_start - TauriAdapter.setup 开始
 * 4. backend_load_start  - 调用后端 chat_v2_load_session
 * 5. backend_load_end    - 后端返回数据
 * 6. restore_start       - restoreFromBackend 开始
 * 7. restore_end         - restoreFromBackend 完成
 * 8. adapter_setup_end   - TauriAdapter.setup 完成
 * 9. first_render        - 首次渲染完成（消息列表可见）
 * 
 * ## 使用方式
 * ```ts
 * import { sessionSwitchPerf } from '@/chat-v2/debug/sessionSwitchPerf';
 * 
 * // 开始追踪
 * sessionSwitchPerf.startTrace(sessionId);
 * 
 * // 记录阶段
 * sessionSwitchPerf.mark('store_get_or_create');
 * 
 * // 结束追踪
 * sessionSwitchPerf.endTrace();
 * ```
 */

// =============================================================================
// 类型定义
// =============================================================================

export type PerfStage =
  | 'click_switch'
  | 'store_get_or_create'
  | 'adapter_setup_start'
  | 'adapter_already_setup'  // 适配器已初始化，快速路径
  | 'adapter_setup_skipped'  // 适配器 setup 被跳过（如非 Tauri 环境）
  // ========== 细粒度调试打点 ==========
  | 'adapter_manager_enter'   // 进入 AdapterManager.getOrCreate
  | 'adapter_manager_found'   // 找到现有适配器
  | 'adapter_manager_wait_setup' // 等待其他 setup 完成
  | 'adapter_manager_create'  // 创建新适配器
  | 'adapter_manager_exit'    // 离开 AdapterManager.getOrCreate
  | 'adapter_data_restored'   // 数据恢复完成，提前标记 ready
  | 'listen_start'            // Tauri listen 开始
  | 'listen_end'              // Tauri listen 完成
  | 'load_start'              // loadSession Promise 开始
  | 'load_invoke_start'       // invoke('chat_v2_load_session') 开始
  | 'load_invoke_end'         // invoke 返回
  | 'load_then_callback'      // loadSession().then() 回调被调用
  | 'await_load_done'         // 数据加载 Promise 已完成（区分 await_resolved 细分）
  | 'await_start'             // await Promise.all 开始
  | 'await_resolved'          // Promise.all 已 resolve（在 .finally 中）
  | 'set_start'               // Zustand set() 开始
  | 'set_end'                 // Zustand set() 结束
  | 'set_data_start'          // 第二批数据更新开始
  | 'set_data_end'            // 第二批数据更新结束
  | 'microtask_check'         // 微任务检查点
  // ========== MessageList 内部打点 ==========
  | 'ml_mount'                // MessageList 组件函数开始执行
  | 'ml_hooks_done'           // hooks 执行完成
  | 'ml_virtualizer_done'     // useVirtualizer 初始化完成
  | 'ml_virtualizer_ready'    // 🚀 P1优化：虚拟化延迟初始化完成
  | 'ml_measure_enabled'      // 🚀 P1优化：measureElement 开启
  | 'ml_get_virtual_items'    // getVirtualItems 耗时
  | 'ml_render_start'         // render 开始
  | 'ml_direct_render_start'  // 直接渲染模式开始
  | 'ml_virtual_render_start' // 虚拟滚动渲染模式开始
  | 'ml_effect_trigger'       // useEffect 触发
  | 'first_render_scheduled'  // 首帧在 render 路径上被调度（区分 Effect 延迟）
  // ========== ChatContainer 内部打点 ==========
  | 'cc_render'               // ChatContainer render
  | 'cc_adapter_state'        // useTauriAdapter 状态变化
  | 'cc_get_or_create_start'  // await getOrCreate 开始
  | 'cc_get_or_create_end'    // await getOrCreate 结束
  // ========== MessageItem 打点 ==========
  | 'mi_render'               // MessageItem render
  // ========== InputBarV2 打点 ==========
  | 'ib_render'               // InputBarV2 render
  | 'ib_effect'               // InputBarV2 useEffect
  // ========== BlockRenderer 打点 ==========
  | 'br_render'               // BlockRenderer render
  // ========== 原有阶段 ==========
  | 'callbacks_injected'     // 回调注入完成
  | 'backend_load_start'     // 后端加载开始（与事件监听并行）
  | 'backend_load_end'
  | 'restore_start'
  | 'restore_end'
  | 'parallel_done'          // 并行任务完成（事件监听+数据加载）
  | 'adapter_setup_end'
  | 'first_render';

export interface PerfMark {
  stage: PerfStage;
  timestamp: number;
  /** 与上一个阶段的间隔（毫秒） */
  delta: number;
  /** 额外数据 */
  data?: Record<string, unknown>;
}

export interface PerfTrace {
  id: string;
  sessionId: string;
  startTime: number;
  endTime: number | null;
  /** 总耗时（毫秒） */
  totalMs: number | null;
  marks: PerfMark[];
  /** 是否从缓存加载 */
  fromCache: boolean;
  /** 消息数量 */
  messageCount: number | null;
  /** 块数量 */
  blockCount: number | null;
  /** 状态: running / completed / aborted */
  status: 'running' | 'completed' | 'aborted';
}

export interface PerfSummary {
  /** 各阶段平均耗时 */
  avgByStage: Record<PerfStage, number>;
  /** 各阶段最大耗时 */
  maxByStage: Record<PerfStage, number>;
  /** 平均总耗时 */
  avgTotal: number;
  /** 最大总耗时 */
  maxTotal: number;
  /** 样本数 */
  sampleCount: number;
  /** 缓存命中率 */
  cacheHitRate: number;
}

// =============================================================================
// 追踪器实现
// =============================================================================

const STAGE_ORDER: PerfStage[] = [
  'click_switch',
  'store_get_or_create',
  'adapter_setup_start',
  'adapter_already_setup',
  // 细粒度阶段
  'adapter_manager_enter',
  'adapter_manager_found',
  'adapter_manager_wait_setup',
  'adapter_manager_create',
  'adapter_manager_exit',
  'adapter_data_restored',
  'listen_start',
  'listen_end',
  'load_start',
  'load_invoke_start',
  'load_invoke_end',
  'load_then_callback',
  'await_load_done',
  'await_start',
  'await_resolved',
  'set_start',
  'set_end',
  'set_data_start',
  'set_data_end',
  'microtask_check',
  // MessageList 内部阶段
  'ml_mount',
  'ml_hooks_done',
  'ml_virtualizer_done',
  'ml_virtualizer_ready',
  'ml_measure_enabled',
  'ml_get_virtual_items',
  'ml_render_start',
  'ml_direct_render_start',
  'ml_virtual_render_start',
  'ml_effect_trigger',
  'first_render_scheduled',
  // ChatContainer 内部阶段
  'cc_render',
  'cc_adapter_state',
  'cc_get_or_create_start',
  'cc_get_or_create_end',
  // MessageItem 阶段
  'mi_render',
  // InputBarV2 阶段
  'ib_render',
  'ib_effect',
  // BlockRenderer 阶段
  'br_render',
  // 原有阶段
  'callbacks_injected',
  'backend_load_start',
  'backend_load_end',
  'restore_start',
  'restore_end',
  'parallel_done',
  'adapter_setup_end',
  'first_render',
];

const STAGE_LABELS: Record<PerfStage, string> = {
  click_switch: '点击切换',
  store_get_or_create: '获取/创建 Store',
  adapter_setup_start: '适配器初始化开始',
  adapter_already_setup: '适配器已初始化',
  adapter_setup_skipped: '适配器 setup 跳过',
  // 细粒度阶段
  adapter_manager_enter: '📍 AdapterManager 进入',
  adapter_manager_found: '📍 找到现有适配器',
  adapter_manager_wait_setup: '📍 等待其他 setup',
  adapter_manager_create: '📍 创建新适配器',
  adapter_manager_exit: '📍 AdapterManager 退出',
  adapter_data_restored: '📍 数据恢复完成（提前 ready）',
  listen_start: '📍 Tauri listen 开始',
  listen_end: '📍 Tauri listen 完成',
  load_start: '📍 loadSession 开始',
  load_invoke_start: '📍 invoke 开始',
  load_invoke_end: '📍 invoke 返回',
  load_then_callback: '📍 .then() 回调执行',
  await_load_done: '📍 数据加载 Promise 完成',
  await_start: '📍 await Promise.all 开始',
  await_resolved: '📍 Promise.all 已 resolve',
  set_start: '📍 Zustand set() 开始',
  set_end: '📍 Zustand set() 结束',
  set_data_start: '📍 数据更新开始',
  set_data_end: '📍 数据更新结束',
  microtask_check: '📍 微任务检查点',
  // MessageList 内部阶段
  ml_mount: '🟡 MessageList 组件函数开始',
  ml_hooks_done: '🟡 hooks 执行完成',
  ml_virtualizer_done: '🟡 useVirtualizer 初始化完成',
  ml_virtualizer_ready: '🟡 虚拟化延迟初始化完成',
  ml_measure_enabled: '🟡 measureElement 开启',
  ml_get_virtual_items: '🟡 getVirtualItems 耗时',
  ml_render_start: '🟡 render 开始',
  ml_direct_render_start: '🟡 直接渲染模式开始',
  ml_virtual_render_start: '🟡 虚拟滚动渲染开始',
  ml_effect_trigger: '🟡 useEffect 触发',
  first_render_scheduled: '🟢 首帧已在 render 调度',
  // ChatContainer 内部阶段
  cc_render: '🔵 ChatContainer render',
  cc_adapter_state: '🔵 Adapter 状态',
  cc_get_or_create_start: '🔵 await getOrCreate 开始',
  cc_get_or_create_end: '🔵 await getOrCreate 结束',
  // MessageItem 阶段
  mi_render: '🟢 MessageItem render',
  // InputBarV2 阶段
  ib_render: '🟣 InputBarV2 render',
  ib_effect: '🟣 InputBarV2 useEffect',
  // BlockRenderer 阶段
  br_render: '⚪ BlockRenderer render',
  // 原有阶段
  callbacks_injected: '回调注入完成',
  backend_load_start: '后端加载开始',
  backend_load_end: '后端加载完成',
  restore_start: '恢复数据开始',
  restore_end: '恢复数据完成',
  parallel_done: '并行任务完成',
  adapter_setup_end: '适配器初始化完成',
  first_render: '首次渲染完成',
};

class SessionSwitchPerfTracker {
  /** 历史追踪记录 */
  private traces: PerfTrace[] = [];
  
  /** 当前追踪 */
  private currentTrace: PerfTrace | null = null;
  
  /** 最大保存数量 */
  private maxTraces = 50;
  
  /** 追踪 ID 计数器 */
  private traceIdCounter = 0;
  
  /** 是否启用（默认仅开发环境开启，避免生产环境高频打点开销） */
  private enabled = (import.meta as any)?.env?.DEV === true;
  
  /** 事件监听器 */
  private listeners = new Set<(trace: PerfTrace) => void>();

  // ========== 控制方法 ==========

  /**
   * 启用/禁用追踪
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled && this.currentTrace) {
      this.abortTrace();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 开始新的追踪
   */
  startTrace(sessionId: string): void {
    if (!this.enabled) return;
    
    // 如果有正在进行的追踪，标记为中断
    if (this.currentTrace) {
      this.abortTrace();
    }

    const now = performance.now();
    this.currentTrace = {
      id: `trace-${++this.traceIdCounter}`,
      sessionId,
      startTime: now,
      endTime: null,
      totalMs: null,
      marks: [{
        stage: 'click_switch',
        timestamp: now,
        delta: 0,
      }],
      fromCache: false,
      messageCount: null,
      blockCount: null,
      status: 'running',
    };

    this.notifyListeners();
  }

  /**
   * 记录阶段打点
   */
  mark(stage: PerfStage, data?: Record<string, unknown>): void {
    if (!this.enabled || !this.currentTrace) return;
    if (stage === 'click_switch') return; // 开始时已记录

    const now = performance.now();
    const lastMark = this.currentTrace.marks[this.currentTrace.marks.length - 1];
    const delta = now - lastMark.timestamp;

    this.currentTrace.marks.push({
      stage,
      timestamp: now,
      delta,
      data,
    });

    // 特殊处理：记录缓存命中
    if (stage === 'adapter_setup_start' && data?.fromCache) {
      this.currentTrace.fromCache = true;
    }

    // 特殊处理：记录数据量
    if (stage === 'backend_load_end') {
      if (typeof data?.messageCount === 'number') {
        this.currentTrace.messageCount = data.messageCount;
      }
      if (typeof data?.blockCount === 'number') {
        this.currentTrace.blockCount = data.blockCount;
      }
    }

    this.notifyListeners();
  }

  /**
   * 结束追踪
   */
  endTrace(): void {
    if (!this.currentTrace) return;

    const now = performance.now();
    this.currentTrace.endTime = now;
    this.currentTrace.totalMs = now - this.currentTrace.startTime;
    this.currentTrace.status = 'completed';

    // 保存到历史
    this.traces.push(this.currentTrace);
    if (this.traces.length > this.maxTraces) {
      this.traces.shift();
    }

    this.notifyListeners();
    this.currentTrace = null;
  }

  /**
   * 中断追踪
   */
  abortTrace(): void {
    if (!this.currentTrace) return;

    const now = performance.now();
    this.currentTrace.endTime = now;
    this.currentTrace.totalMs = now - this.currentTrace.startTime;
    this.currentTrace.status = 'aborted';

    // 保存到历史
    this.traces.push(this.currentTrace);
    if (this.traces.length > this.maxTraces) {
      this.traces.shift();
    }

    this.notifyListeners();
    this.currentTrace = null;
  }

  // ========== 查询方法 ==========

  /**
   * 获取当前追踪
   */
  getCurrentTrace(): PerfTrace | null {
    return this.currentTrace;
  }

  /**
   * 获取所有历史追踪
   */
  getTraces(): PerfTrace[] {
    return [...this.traces];
  }

  /**
   * 获取最近 N 条追踪
   */
  getRecentTraces(n: number): PerfTrace[] {
    return this.traces.slice(-n);
  }

  /**
   * 获取性能统计摘要
   */
  getSummary(): PerfSummary | null {
    const completedTraces = this.traces.filter(t => t.status === 'completed');
    if (completedTraces.length === 0) return null;

    const avgByStage: Record<PerfStage, number> = {} as Record<PerfStage, number>;
    const maxByStage: Record<PerfStage, number> = {} as Record<PerfStage, number>;
    const stageCounts: Record<PerfStage, number> = {} as Record<PerfStage, number>;

    for (const stage of STAGE_ORDER) {
      avgByStage[stage] = 0;
      maxByStage[stage] = 0;
      stageCounts[stage] = 0;
    }

    let totalSum = 0;
    let maxTotal = 0;
    let cacheHits = 0;

    for (const trace of completedTraces) {
      if (trace.totalMs !== null) {
        totalSum += trace.totalMs;
        maxTotal = Math.max(maxTotal, trace.totalMs);
      }
      if (trace.fromCache) {
        cacheHits++;
      }

      for (const mark of trace.marks) {
        if (mark.stage !== 'click_switch') {
          avgByStage[mark.stage] += mark.delta;
          maxByStage[mark.stage] = Math.max(maxByStage[mark.stage], mark.delta);
          stageCounts[mark.stage]++;
        }
      }
    }

    // 计算平均值
    for (const stage of STAGE_ORDER) {
      if (stageCounts[stage] > 0) {
        avgByStage[stage] /= stageCounts[stage];
      }
    }

    return {
      avgByStage,
      maxByStage,
      avgTotal: totalSum / completedTraces.length,
      maxTotal,
      sampleCount: completedTraces.length,
      cacheHitRate: cacheHits / completedTraces.length,
    };
  }

  /**
   * 清除所有记录
   */
  clear(): void {
    this.traces = [];
    this.currentTrace = null;
    this.notifyListeners();
  }

  // ========== 事件订阅 ==========

  /**
   * 添加监听器
   */
  addListener(listener: (trace: PerfTrace) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    const trace = this.currentTrace || this.traces[this.traces.length - 1];
    if (trace) {
      this.listeners.forEach(listener => listener(trace));
    }
  }

  // ========== 工具方法 ==========

  /**
   * 获取阶段标签
   */
  getStageLabel(stage: PerfStage): string {
    return STAGE_LABELS[stage] || stage;
  }

  /**
   * 获取阶段顺序
   */
  getStageOrder(): PerfStage[] {
    return [...STAGE_ORDER];
  }

  /**
   * 生成详细调试报告（JSON 格式）
   * 
   * 在控制台运行: copy(__sessionSwitchPerf.generateDetailedReport())
   */
  generateDetailedReport(): string {
    const report = {
      generatedAt: new Date().toISOString(),
      enabled: this.enabled,
      summary: this.getSummary(),
      recentTraces: this.getRecentTraces(10),
      // 细粒度阶段分析
      detailedAnalysis: this.analyzeDetailedStages(),
    };
    return JSON.stringify(report, null, 2);
  }

  /**
   * 分析细粒度阶段耗时
   */
  private analyzeDetailedStages(): Record<string, { avg: number; max: number; count: number }> {
    const completedTraces = this.traces.filter(t => t.status === 'completed');
    const analysis: Record<string, { sum: number; max: number; count: number }> = {};

    for (const trace of completedTraces) {
      for (const mark of trace.marks) {
        if (!analysis[mark.stage]) {
          analysis[mark.stage] = { sum: 0, max: 0, count: 0 };
        }
        analysis[mark.stage].sum += mark.delta;
        analysis[mark.stage].max = Math.max(analysis[mark.stage].max, mark.delta);
        analysis[mark.stage].count++;
      }
    }

    // 转换为平均值
    const result: Record<string, { avg: number; max: number; count: number }> = {};
    for (const [stage, data] of Object.entries(analysis)) {
      result[stage] = {
        avg: data.count > 0 ? data.sum / data.count : 0,
        max: data.max,
        count: data.count,
      };
    }

    return result;
  }

  /**
   * 打印最近一条 trace 的详细时间线
   */
  printLastTrace(): void {
    const traces = this.getTraces();
    if (traces.length === 0) {
      console.log('%c[SessionSwitchPerf] No trace records', 'color: #888');
      return;
    }

    const lastTrace = traces[traces.length - 1];
    console.log('%c═══════════════════════════════════════════════════════════════', 'color: #10B981');
    console.log(`%cSession Switch Perf Trace [${lastTrace.id}]`, 'color: #10B981; font-weight: bold; font-size: 14px');
    console.log(`%cSession: ${lastTrace.sessionId}`, 'color: #888');
    console.log(`%cTotal: ${lastTrace.totalMs?.toFixed(1)}ms | Status: ${lastTrace.status}`, 'color: #888');
    console.log('%c───────────────────────────────────────────────────────────────', 'color: #666');
    
    for (const mark of lastTrace.marks) {
      const label = STAGE_LABELS[mark.stage] || mark.stage;
      const deltaStr = mark.delta.toFixed(1).padStart(8);
      const color = mark.delta > 100 ? '#EF4444' : mark.delta > 50 ? '#F59E0B' : '#10B981';
      const indicator = mark.delta > 100 ? '🔴' : mark.delta > 50 ? '🟠' : '🟢';
      
      console.log(
        `%c${indicator} ${label.padEnd(25)} %c+${deltaStr}ms`,
        'color: #fff',
        `color: ${color}; font-weight: bold`
      );
      
      if (mark.data) {
        console.log(`%c    └─ ${JSON.stringify(mark.data)}`, 'color: #888; font-size: 11px');
      }
    }
    
    console.log('%c═══════════════════════════════════════════════════════════════', 'color: #10B981');
  }
}

// =============================================================================
// 导出单例
// =============================================================================

export const sessionSwitchPerf = new SessionSwitchPerfTracker();

// 暴露到全局供调试
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__sessionSwitchPerf = sessionSwitchPerf;
}
