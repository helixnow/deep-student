/**
 * 测试录制回放与Mock注入系统
 * 支持录制真实测试流程并回放，以及注入Mock数据
 */

// Local type definitions to avoid circular dependencies
export type TestStepCategory = 'basic' | 'rag' | 'graph' | 'search' | 'memory' | 'attachment' | 'error' | 'concurrency';

export interface TestStep {
  id: string;
  name: string;
  action: string; // 'type', 'click', 'wait', 'assert', 'navigate', 'toggle'
  target?: string; // data-testid or selector
  value?: string | number | boolean;
  timeout?: number;
  expected?: unknown;
  /** 输入前是否清空目标内容 */
  clearBefore?: boolean;
}

export interface TestCase {
  id: string;
  name: string;
  description: string;
  category: TestStepCategory;
  steps: TestStep[];
  dependencies?: string[]; // 依赖的服务：'graph_rag', 'web_search'
}

export interface RecordedTestRun {
  id: string;
  timestamp: number;
  testCaseId: string;
  testCase: TestCase;
  steps: RecordedStep[];
  snapshots: Array<{
    ts: number;
    layer: string;
    data: any;
  }>;
  metadata: {
    duration: number;
    status: 'success' | 'failed';
    error?: string;
  };
}

export interface RecordedStep extends TestStep {
  recordedAt: number;
  duration?: number;
  actualResult?: any;
  error?: string;
}

export type ReplayMode = 'full' | 'mock' | 'hybrid';

export interface ReplayOptions {
  mode: ReplayMode;
  mockData?: Record<string, any>;
  skipSteps?: string[]; // 要跳过的步骤ID
  speedMultiplier?: number; // 回放速度倍数（1.0 = 正常速度，2.0 = 2倍速）
}

/**
 * 测试录制器
 */
export class TestRecorder {
  private recordings: Map<string, RecordedTestRun> = new Map();
  private currentRecording: RecordedTestRun | null = null;
  private isRecording = false;

  /**
   * 开始录制
   */
  startRecording(testCaseId: string, testCase: TestCase): string {
    const recordingId = `record-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const recording: RecordedTestRun = {
      id: recordingId,
      timestamp: Date.now(),
      testCaseId,
      testCase,
      steps: [],
      snapshots: [],
      metadata: {
        duration: 0,
        status: 'success',
      },
    };

    this.currentRecording = recording;
    this.isRecording = true;
    this.recordings.set(recordingId, recording);

    return recordingId;
  }

  /**
   * 录制步骤
   */
  recordStep(step: TestStep, result?: any, error?: Error): void {
    if (!this.isRecording || !this.currentRecording) return;

    const recordedStep: RecordedStep = {
      ...step,
      recordedAt: Date.now(),
      actualResult: result,
      error: error ? error.message : undefined,
    };

    this.currentRecording.steps.push(recordedStep);
  }

  /**
   * 录制快照
   */
  recordSnapshot(layer: string, data: any): void {
    if (!this.isRecording || !this.currentRecording) return;

    this.currentRecording.snapshots.push({
      ts: Date.now(),
      layer,
      data,
    });
  }

  /**
   * 停止录制
   */
  stopRecording(status: 'success' | 'failed', error?: string): RecordedTestRun | null {
    if (!this.currentRecording) return null;

    this.currentRecording.metadata.status = status;
    this.currentRecording.metadata.error = error;
    this.currentRecording.metadata.duration = Date.now() - this.currentRecording.timestamp;

    const recording = this.currentRecording;
    this.currentRecording = null;
    this.isRecording = false;

    return recording;
  }

  /**
   * 获取录制
   */
  getRecording(id: string): RecordedTestRun | undefined {
    return this.recordings.get(id);
  }

  /**
   * 获取所有录制
   */
  getAllRecordings(): RecordedTestRun[] {
    return Array.from(this.recordings.values()).sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 删除录制
   */
  deleteRecording(id: string): boolean {
    return this.recordings.delete(id);
  }

  /**
   * 导出录制为JSON
   */
  exportRecording(id: string): string | null {
    const recording = this.recordings.get(id);
    if (!recording) return null;

    return JSON.stringify(recording, null, 2);
  }

  /**
   * 导入录制
   */
  importRecording(json: string): string | null {
    try {
      const recording = JSON.parse(json) as RecordedTestRun;
      const id = recording.id || `imported-${Date.now()}`;
      recording.id = id;
      this.recordings.set(id, recording);
      return id;
    } catch (error: unknown) {
      console.error('[TestRecorder] Import failed:', error);
      return null;
    }
  }

  /**
   * 清除所有录制
   */
  clearAll(): void {
    this.recordings.clear();
    this.currentRecording = null;
    this.isRecording = false;
  }
}

/**
 * 测试回放器
 */
export class TestReplayer {
  private recorder: TestRecorder;
  private mockData: Map<string, any> = new Map();
  private replaySpeed = 1.0;

  constructor(recorder: TestRecorder) {
    this.recorder = recorder;
  }

  /**
   * 设置Mock数据
   */
  setMockData(key: string, value: any): void {
    this.mockData.set(key, value);
  }

  /**
   * 设置回放速度
   */
  setReplaySpeed(multiplier: number): void {
    this.replaySpeed = multiplier;
  }

  /**
   * 回放录制
   */
  async replay(
    recordingId: string,
    options: ReplayOptions,
    stepHandler: (step: TestStep) => Promise<any>
  ): Promise<{ success: boolean; error?: string }> {
    const recording = this.recorder.getRecording(recordingId);
    if (!recording) {
      return { success: false, error: `Recording not found: ${recordingId}` };
    }

    this.replaySpeed = options.speedMultiplier || 1.0;

    try {
      for (const recordedStep of recording.steps) {
        // 跳过指定的步骤
        if (options.skipSteps?.includes(recordedStep.id)) {
          continue;
        }

        // 根据不同模式处理
        if (options.mode === 'mock') {
          // Mock模式：直接返回录制的实际结果
          if (recordedStep.actualResult) {
            // 应用Mock数据覆盖
            const mockResult = this.applyMockData(recordedStep.actualResult, options.mockData);
            continue; // Mock模式下不执行实际步骤
          }
        } else if (options.mode === 'hybrid') {
          // 混合模式：有Mock数据时使用Mock，否则执行实际步骤
          if (options.mockData && this.hasMockDataForStep(recordedStep)) {
            const mockResult = this.applyMockData(recordedStep.actualResult, options.mockData);
            continue;
          }
        }

        // Full模式或没有Mock：执行实际步骤
        const stepDelay = recordedStep.duration 
          ? (recordedStep.duration / this.replaySpeed) 
          : 0;

        if (stepDelay > 0) {
          await this.sleep(stepDelay);
        }

        try {
          await stepHandler(recordedStep);
        } catch (error: unknown) {
          // 如果步骤失败，根据模式决定是否继续
          if (options.mode === 'mock') {
            // Mock模式下，如果原始步骤有错误，可以选择跳过或使用Mock数据
            continue;
          } else {
            throw error;
          }
        }
      }

      return { success: true };
    } catch (error: unknown) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : String(error) 
      };
    }
  }

  /**
   * 检查步骤是否有Mock数据
   */
  private hasMockDataForStep(step: TestStep): boolean {
    // 检查是否有针对此步骤的Mock数据
    return this.mockData.has(step.id) || 
           this.mockData.has(`${step.action}:${step.target}`);
  }

  /**
   * 应用Mock数据
   */
  private applyMockData(originalResult: any, mockData?: Record<string, any>): any {
    if (!mockData) return originalResult;

    // 深度合并Mock数据
    return deepMerge(originalResult, mockData);
  }

  /**
   * 延迟执行
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * 深度合并对象
 */
function deepMerge(target: any, source: any): any {
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

function isObject(item: any): boolean {
  return item && typeof item === 'object' && !Array.isArray(item);
}

// ==================== 导出单例 ====================

export const testRecorder = new TestRecorder();
export const testReplayer = new TestReplayer(testRecorder);

