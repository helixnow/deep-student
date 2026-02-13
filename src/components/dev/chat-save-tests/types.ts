/**
 * 聊天保存测试系统 - 类型定义
 */

export type TestScenario = 'delete' | 'stream-complete' | 'manual-stop' | 'edit-resend' | 'manual-save' | 'complete-flow';

export type ErrorType = 'network' | 'validation' | 'timeout' | 'permission' | 'data-corruption' | 'unknown' | 'logic';

export interface TestStep {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  message?: string;
  data?: any;
  duration?: number;
  errorType?: ErrorType;
}

export interface TestLog {
  time: string;
  level: 'info' | 'success' | 'error' | 'warning' | 'debug';
  message: string;
  data?: any;
  errorType?: ErrorType;
}

export interface TestScenarioConfig {
  id: TestScenario;
  name: string;
  description: string;
  icon: any;
  color: string;
  steps: string[];
  implemented: boolean;
}

export interface AutoTestResult {
  scenario: TestScenario;
  scenarioName: string;
  status: 'success' | 'failed' | 'skipped';
  duration: number;
  error?: string;
  steps?: TestStep[];
}

export interface MessageSnapshot {
  role: string;
  content: string;
  stableId: string;
  timestamp?: string;
  metadata?: {
    hasThinking?: boolean;
    hasSources?: boolean;
    hasAttachments?: boolean;
  };
}

export interface TestContext {
  currentMistakeId: string;
  mode: string;
  runtimeRef?: React.MutableRefObject<any>;
  addLog: (level: TestLog['level'], message: string, data?: any, errorType?: ErrorType) => void;
  updateStep: (id: string, updates: Partial<TestStep>) => void;
  t: (key: string, options?: any) => string;
}

export interface TestDataRef {
  initialMsgCount: number;
  initialSnapshot: MessageSnapshot[];
  targetStableId?: string;
  testMessageId?: string;
  startTime?: number;
}

