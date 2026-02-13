/**
 * MCP Debug Enhancement Module - Type Definitions
 * 为全自动调试提供类型支持
 */

// ============================================================================
// 错误捕获类型
// ============================================================================

export interface CapturedError {
  id: string;
  type: 'error' | 'unhandledrejection' | 'react-error-boundary' | 'console-error';
  message: string;
  stack?: string;
  componentStack?: string; // React 错误边界提供
  source?: string;
  lineno?: number;
  colno?: number;
  timestamp: number;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface ErrorCaptureState {
  enabled: boolean;
  errors: CapturedError[];
  maxErrors: number;
}

// ============================================================================
// 网络监控类型
// ============================================================================

export interface NetworkRequest {
  id: string;
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseBody?: unknown;
  responseType?: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  error?: string;
  aborted?: boolean;
  type: 'fetch' | 'xhr' | 'websocket';
}

export interface WebSocketMessage {
  id: string;
  socketId: string;
  url: string;
  direction: 'sent' | 'received';
  data: unknown;
  timestamp: number;
  type: 'message' | 'open' | 'close' | 'error';
}

export interface NetworkMonitorState {
  enabled: boolean;
  requests: NetworkRequest[];
  websocketMessages: WebSocketMessage[];
  maxEntries: number;
}

// ============================================================================
// 状态调试类型
// ============================================================================

export interface StoreSnapshot {
  storeName: string;
  state: unknown;
  timestamp: number;
}

export interface StateChange {
  id: string;
  storeName: string;
  path: string[];
  previousValue: unknown;
  newValue: unknown;
  timestamp: number;
  action?: string;
}

export interface StoreDebuggerState {
  enabled: boolean;
  snapshots: StoreSnapshot[];
  changes: StateChange[];
  subscribedStores: string[];
  maxChanges: number;
}

// ============================================================================
// 操作录制类型
// ============================================================================

export type ActionType = 
  | 'click'
  | 'dblclick'
  | 'input'
  | 'change'
  | 'keydown'
  | 'keyup'
  | 'scroll'
  | 'focus'
  | 'blur'
  | 'submit'
  | 'select'
  | 'navigate'
  | 'custom';

export interface RecordedAction {
  id: string;
  type: ActionType;
  timestamp: number;
  target: {
    selector: string;
    tagName: string;
    id?: string;
    className?: string;
    textContent?: string;
    attributes?: Record<string, string>;
  };
  data?: {
    value?: string;
    key?: string;
    keyCode?: number;
    modifiers?: {
      ctrl?: boolean;
      alt?: boolean;
      shift?: boolean;
      meta?: boolean;
    };
    scrollX?: number;
    scrollY?: number;
    x?: number;
    y?: number;
    url?: string;
  };
  screenshot?: string; // base64 缩略图
}

export interface ActionRecorderState {
  recording: boolean;
  actions: RecordedAction[];
  startTime?: number;
  maxActions: number;
}

// ============================================================================
// 性能监控类型
// ============================================================================

export interface PerformanceMetrics {
  timestamp: number;
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
  fps?: number;
  domNodes?: number;
  eventListeners?: number;
}

export interface LongTask {
  id: string;
  startTime: number;
  duration: number;
  name: string;
  attribution?: Array<{
    name: string;
    containerType?: string;
    containerSrc?: string;
  }>;
}

export interface RenderTiming {
  componentName: string;
  phase: 'mount' | 'update';
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
}

export interface PerformanceMonitorState {
  enabled: boolean;
  metrics: PerformanceMetrics[];
  longTasks: LongTask[];
  renderTimings: RenderTiming[];
  sampleInterval: number;
  maxSamples: number;
}

// ============================================================================
// 元素高亮类型
// ============================================================================

export interface HighlightOptions {
  selector: string;
  color?: string;
  backgroundColor?: string;
  borderWidth?: number;
  duration?: number; // ms, 0 = 永久
  label?: string;
  pulse?: boolean;
}

export interface HighlightedElement {
  id: string;
  selector: string;
  options: HighlightOptions;
  overlayElement?: HTMLElement;
  createdAt: number;
}

// ============================================================================
// 断言类型
// ============================================================================

export type AssertionType = 
  | 'element-exists'
  | 'element-not-exists'
  | 'element-visible'
  | 'element-hidden'
  | 'text-contains'
  | 'text-equals'
  | 'attribute-equals'
  | 'class-contains'
  | 'state-equals'
  | 'state-matches'
  | 'count-equals'
  | 'custom';

export interface Assertion {
  id: string;
  type: AssertionType;
  selector?: string;
  expected: unknown;
  actual?: unknown;
  passed: boolean;
  message?: string;
  timestamp: number;
  duration?: number;
}

// ============================================================================
// MCP Bridge 类型
// ============================================================================

export type MCPDebugCommand = 
  // 错误捕获
  | { cmd: 'error:start' }
  | { cmd: 'error:stop' }
  | { cmd: 'error:get'; filter?: string }
  | { cmd: 'error:clear' }
  // 网络监控
  | { cmd: 'network:start' }
  | { cmd: 'network:stop' }
  | { cmd: 'network:get'; filter?: { url?: string; status?: number; method?: string } }
  | { cmd: 'network:clear' }
  // 状态调试
  | { cmd: 'store:snapshot'; storeName?: string }
  | { cmd: 'store:subscribe'; storeName: string; selector?: string }
  | { cmd: 'store:unsubscribe'; storeName: string }
  | { cmd: 'store:getChanges'; storeName?: string }
  | { cmd: 'store:clear' }
  // 操作录制
  | { cmd: 'action:startRecording' }
  | { cmd: 'action:stopRecording' }
  | { cmd: 'action:getRecorded' }
  | { cmd: 'action:replay'; actions: RecordedAction[]; speed?: number }
  | { cmd: 'action:clear' }
  // 性能监控
  | { cmd: 'perf:start'; interval?: number }
  | { cmd: 'perf:stop' }
  | { cmd: 'perf:get' }
  | { cmd: 'perf:clear' }
  | { cmd: 'perf:gc' }
  // 元素高亮
  | { cmd: 'highlight:show'; options: HighlightOptions }
  | { cmd: 'highlight:hide'; id?: string }
  | { cmd: 'highlight:clear' }
  // 断言
  | { cmd: 'assert:check'; type: AssertionType; selector?: string; expected: unknown }
  | { cmd: 'assert:batch'; assertions: Array<{ type: AssertionType; selector?: string; expected: unknown }> }
  // 选择器
  | { cmd: 'selector:suggest'; x: number; y: number }
  | { cmd: 'selector:validate'; selector: string }
  // 通用
  | { cmd: 'status' }
  | { cmd: 'reset' };

export interface MCPDebugResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

// ============================================================================
// 全局状态类型
// ============================================================================

export interface MCPDebugGlobalState {
  initialized: boolean;
  version: string;
  errorCapture: ErrorCaptureState;
  networkMonitor: NetworkMonitorState;
  storeDebugger: StoreDebuggerState;
  actionRecorder: ActionRecorderState;
  performanceMonitor: PerformanceMonitorState;
  highlightedElements: HighlightedElement[];
}

// 全局 window 扩展
declare global {
  interface Window {
    __MCP_DEBUG__?: MCPDebugAPI;
  }
}

export interface MCPDebugAPI {
  // 版本和状态
  version: string;
  getStatus(): MCPDebugGlobalState;
  reset(): void;
  
  // 错误捕获
  errorCapture: {
    start(): void;
    stop(): void;
    get(filter?: string): CapturedError[];
    clear(): void;
  };
  
  // 网络监控
  networkMonitor: {
    start(): void;
    stop(): void;
    get(filter?: { url?: string; status?: number; method?: string }): NetworkRequest[];
    getWebSocket(): WebSocketMessage[];
    clear(): void;
  };
  
  // 状态调试
  storeDebugger: {
    snapshot(storeName?: string): StoreSnapshot[];
    subscribe(storeName: string, selector?: string): void;
    unsubscribe(storeName: string): void;
    getChanges(storeName?: string): StateChange[];
    clear(): void;
    getRegisteredStores(): string[];
    registerStore(name: string, store: unknown): void;
  };
  
  // 操作录制
  actionRecorder: {
    start(): void;
    stop(): RecordedAction[];
    get(): RecordedAction[];
    replay(actions: RecordedAction[], speed?: number): Promise<void>;
    clear(): void;
  };
  
  // 性能监控
  performanceMonitor: {
    start(interval?: number): void;
    stop(): void;
    get(): { metrics: PerformanceMetrics[]; longTasks: LongTask[]; renderTimings: RenderTiming[] };
    clear(): void;
    gc(): void;
  };
  
  // 元素高亮
  highlighter: {
    show(options: HighlightOptions): string;
    hide(id?: string): void;
    clear(): void;
  };
  
  // 断言
  assert: {
    check(type: AssertionType, selector?: string, expected?: unknown): Assertion;
    batch(assertions: Array<{ type: AssertionType; selector?: string; expected: unknown }>): Assertion[];
  };
  
  // 选择器工具
  selector: {
    suggest(x: number, y: number): string[];
    validate(selector: string): { valid: boolean; count: number };
  };
  
  // AI 自动调试核心功能
  smartActions: {
    waitForElement(selector: string, options?: { timeout?: number; interval?: number; visible?: boolean; enabled?: boolean }): Promise<{ found: boolean; element?: Element; elapsed: number; error?: string }>;
    waitForText(text: string, options?: { timeout?: number; interval?: number; visible?: boolean; exact?: boolean }): Promise<{ found: boolean; element?: Element; elapsed: number; error?: string }>;
    waitForCondition(conditionFn: () => boolean | Promise<boolean>, options?: { timeout?: number; interval?: number }): Promise<{ success: boolean; elapsed: number; error?: string }>;
    findByText(text: string, options?: { exact?: boolean; selector?: string }): Element[];
    findByRole(role: string, options?: { name?: string }): Element[];
    findByLabel(label: string): Element | null;
    clickText(text: string, options?: { exact?: boolean; tag?: string; timeout?: number; interval?: number; visible?: boolean }): Promise<{ success: boolean; element?: Element; error?: string }>;
    clickElement(selector: string, options?: { timeout?: number; interval?: number; visible?: boolean }): Promise<{ success: boolean; error?: string }>;
    fillInput(target: string | { label?: string; placeholder?: string; selector?: string }, value: string, options?: { timeout?: number; clear?: boolean }): Promise<{ success: boolean; element?: Element; error?: string }>;
    generateSelector(el: Element): string;
    getElementInfo(el: Element): { tag: string; id?: string; classes: string[]; text: string; role?: string; rect: { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number }; visible: boolean; enabled: boolean; selector: string };
    exportToPlaywright(actions: RecordedAction[]): string;
    exportToJS(actions: RecordedAction[]): string;
  };
  
  // MCP 桥接
  handleCommand(command: MCPDebugCommand): Promise<MCPDebugResponse>;
}
