/**
 * 测试失败根因分析与指纹识别
 * 通过分析快照、日志和错误信息，生成失败指纹并提供修复建议
 */

import type { Snapshot, SnapshotLayer } from './testSnapshot';
import { getErrorMessage } from './errorUtils';

export interface FailureFingerprint {
  id: string;
  category: FailureCategory;
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  layers: SnapshotLayer[];
  errorPattern?: string;
  suggestion: string;
  relatedSnapshots?: number[];
}

export type FailureCategory =
  | 'timeout'
  | 'element_not_found'
  | 'api_error'
  | 'validation_error'
  | 'state_inconsistency'
  | 'stream_error'
  | 'database_error'
  | 'network_error'
  | 'unknown';

export interface RootCauseAnalysis {
  fingerprint: FailureFingerprint;
  firstOccurrence: number;
  occurrences: number;
  context: {
    step?: string;
    lastSuccessfulLayer?: SnapshotLayer;
    failedLayer?: SnapshotLayer;
    errorMessage?: string;
  };
}

/**
 * 分析测试失败根因
 */
export function analyzeRootCause(
  snapshots: Snapshot[],
  logs: Array<{ ts: number; level: string; message: string; stepId?: string }>,
  error?: Error | string
): RootCauseAnalysis | null {
  if (!error && logs.filter(l => l.level === 'error').length === 0) {
    return null;
  }

  const errorMessage = typeof error === 'string' ? error : getErrorMessage(error);
  const errorLogs = logs.filter(l => l.level === 'error');
  const lastErrorLog = errorLogs[errorLogs.length - 1];

  // 识别失败类别
  const category = identifyFailureCategory(errorMessage, snapshots, logs);
  
  // 生成指纹
  const fingerprint = generateFingerprint(category, errorMessage, snapshots, logs);

  // 分析上下文
  const lastSnapshot = snapshots[snapshots.length - 1];
  const lastSuccessSnapshot = [...snapshots].reverse().find(
    s => s.layer !== 'metrics' && !s.data?.error
  );

  return {
    fingerprint,
    firstOccurrence: errorLogs[0]?.ts || Date.now(),
    occurrences: errorLogs.length,
    context: {
      step: lastErrorLog?.stepId,
      lastSuccessfulLayer: lastSuccessSnapshot?.layer,
      failedLayer: lastSnapshot?.layer,
      errorMessage,
    },
  };
}

/**
 * 识别失败类别
 */
function identifyFailureCategory(
  errorMessage: string,
  snapshots: Snapshot[],
  logs: Array<{ level: string; message: string }>
): FailureCategory {
  const msg = errorMessage.toLowerCase();

  // 超时错误
  if (msg.includes('timeout') || msg.includes('timed out')) {
    return 'timeout';
  }

  // 元素未找到
  if (msg.includes('not found') || msg.includes('element') && msg.includes('data-testid')) {
    return 'element_not_found';
  }

  // API错误
  if (msg.includes('invoke') || msg.includes('tauri') || msg.includes('command')) {
    const apiErrorSnapshot = snapshots.find(s => s.layer === 'invoke' && s.data?.error);
    if (apiErrorSnapshot) {
      return 'api_error';
    }
  }

  // 数据库错误
  if (msg.includes('database') || msg.includes('sqlite') || msg.includes('db')) {
    return 'database_error';
  }

  // 网络错误
  if (msg.includes('network') || msg.includes('fetch') || msg.includes('request failed')) {
    return 'network_error';
  }

  // 流式错误
  const streamError = snapshots.find(
    s => s.layer === 'runtime' && (s.data?.error || s.data?.phase === 'error')
  );
  if (streamError) {
    return 'stream_error';
  }

  // 验证错误
  if (msg.includes('assert') || msg.includes('validation') || msg.includes('expected')) {
    return 'validation_error';
  }

  // 状态不一致
  const stateSnapshots = snapshots.filter(s => s.layer === 'runtime');
  if (stateSnapshots.length > 0) {
    const inconsistent = stateSnapshots.find(
      s => s.data?.state && JSON.stringify(s.data.state).includes('null') || 
           s.data?.state && JSON.stringify(s.data.state).includes('undefined')
    );
    if (inconsistent) {
      return 'state_inconsistency';
    }
  }

  return 'unknown';
}

/**
 * 生成失败指纹
 */
function generateFingerprint(
  category: FailureCategory,
  errorMessage: string,
  snapshots: Snapshot[],
  logs: Array<{ level: string; message: string }>
): FailureFingerprint {
  const errorPattern = extractErrorPattern(errorMessage);
  const involvedLayers = getInvolvedLayers(snapshots, logs);
  
  // 根据类别生成指纹ID
  const fingerprintId = `${category}_${errorPattern}_${involvedLayers.join('_')}`;

  // 根据类别生成建议
  const suggestion = generateSuggestion(category, errorMessage, involvedLayers);

  // 确定严重程度
  const severity = determineSeverity(category, involvedLayers);

  // 找出相关快照索引
  const relatedSnapshots = snapshots
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => 
      s.data?.error || 
      (involvedLayers.includes(s.layer) && 
       (errorPattern && JSON.stringify(s.data).includes(errorPattern)))
    )
    .map(({ idx }) => idx);

  return {
    id: fingerprintId,
    category,
    severity,
    description: getCategoryDescription(category, errorMessage),
    layers: involvedLayers,
    errorPattern,
    suggestion,
    relatedSnapshots: relatedSnapshots.length > 0 ? relatedSnapshots : undefined,
  };
}

/**
 * 提取错误模式
 */
function extractErrorPattern(errorMessage: string): string {
  // 提取关键错误信息（去除动态内容）
  let pattern = errorMessage
    .replace(/\d+/g, 'N') // 替换数字
    .replace(/['"]]/g, '') // 移除引号
    .replace(/\s+/g, '_') // 替换空格
    .substring(0, 50); // 截取前50个字符

  return pattern;
}

/**
 * 获取涉及的相关层
 */
function getInvolvedLayers(
  snapshots: Snapshot[],
  logs: Array<{ level: string; message: string }>
): SnapshotLayer[] {
  const layers = new Set<SnapshotLayer>();

  // 从快照中提取层
  snapshots.forEach(s => {
    if (s.data?.error || s.data?.phase === 'error') {
      layers.add(s.layer);
    }
  });

  // 从日志中推断层
  logs.forEach(log => {
    if (log.level === 'error') {
      if (log.message.includes('ui') || log.message.includes('element')) {
        layers.add('ui');
      }
      if (log.message.includes('invoke') || log.message.includes('tauri')) {
        layers.add('invoke');
      }
      if (log.message.includes('runtime') || log.message.includes('stream')) {
        layers.add('runtime');
      }
      if (log.message.includes('event')) {
        layers.add('event');
      }
    }
  });

  return Array.from(layers);
}

/**
 * 生成修复建议
 */
function generateSuggestion(
  category: FailureCategory,
  errorMessage: string,
  layers: SnapshotLayer[]
): string {
  const suggestions: Record<FailureCategory, string> = {
    timeout: `检测到超时错误。建议：1) 检查网络连接与API响应速度，2) 适当增加超时时间（当前可能偏短），3) 检查测试数据库播种是否完成（可能仍在异步写入），4) 查看相关层的快照以定位具体瓶颈。涉及层：${layers.join(', ')}`,
    element_not_found: `元素未找到错误。建议：1) 检查 data-testid 是否正确添加到 DOM 元素，2) 等待元素出现（可增加 waitForElement 超时或使用 waitForElementOrEvent），3) 检查元素是否被动态移除或未渲染，4) 验证导航是否已完成（视图切换延迟）。涉及层：UI`,
    api_error: `API调用错误。建议：1) 检查后端命令实现与返回格式，2) 验证参数格式与必填字段，3) 查看 invoke 层快照获取详细错误信息，4) 检查 Tauri 权限配置（capabilities/*.json）。涉及层：${layers.includes('invoke') ? 'Invoke' : 'Unknown'}`,
    validation_error: `验证/断言失败。建议：1) 检查期望值与实际值（可能因数据播种不完整），2) 验证测试数据是否正确（检查 seed_test_database 返回值），3) 检查断言逻辑与选择器，4) 查看相关快照对比预期和实际状态。`,
    state_inconsistency: `状态不一致。建议：1) 检查运行时状态管理（可能因异步更新未完成），2) 验证数据流与 Runtime 同步逻辑，3) 查看 runtime 层快照追踪状态变化，4) 检查组件生命周期与 useEffect 依赖。涉及层：Runtime`,
    stream_error: `流式处理错误。建议：1) 检查 CHAT_STREAM_COMPLETE 事件是否正确派发（应在 onComplete 回调中），2) 验证流式处理器配置与监听器挂载，3) 查看 runtime 层快照了解流式状态，4) 检查 API 配置与模型可用性。涉及层：Runtime`,
    database_error: `数据库错误。建议：1) 检查测试数据库是否已切换（switch_to_test_database），2) 验证数据库文件权限与路径，3) 查看数据库模式与迁移是否正确，4) 检查 reset/seed 操作是否成功完成（查看播种返回的 errors 数组）。`,
    network_error: `网络错误。建议：1) 检查网络连接与防火墙，2) 验证API端点是否可访问（Prometheus/Graph RAG等），3) 检查CORS配置（仅浏览器环境），4) 查看 Metrics 层快照与依赖健康检查结果。`,
    unknown: `未知错误类型。建议：1) 查看完整错误堆栈与控制台日志，2) 检查所有层的快照（UI/Runtime/Invoke/Event/Metrics），3) 对比成功和失败的快照差异，4) 查看测试日志获取更多上下文，5) 检查是否为环境特定问题（浏览器/操作系统）。`,
  };

  return suggestions[category] || suggestions.unknown;
}

/**
 * 获取类别描述
 */
function getCategoryDescription(category: FailureCategory, errorMessage: string): string {
  const descriptions: Record<FailureCategory, string> = {
    timeout: '操作超时',
    element_not_found: 'UI元素未找到',
    api_error: '后端API调用失败',
    validation_error: '验证/断言失败',
    state_inconsistency: '运行时状态不一致',
    stream_error: '流式处理错误',
    database_error: '数据库操作失败',
    network_error: '网络请求失败',
    unknown: '未知错误类型',
  };

  const baseDesc = descriptions[category];
  const shortError = errorMessage.substring(0, 50);
  
  return `${baseDesc}: ${shortError}${errorMessage.length > 50 ? '...' : ''}`;
}

/**
 * 确定严重程度
 */
function determineSeverity(category: FailureCategory, layers: SnapshotLayer[]): FailureFingerprint['severity'] {
  // 如果涉及多个层，严重程度更高
  if (layers.length > 2) {
    return 'critical';
  }

  // 根据类别判断
  const criticalCategories: FailureCategory[] = ['database_error', 'api_error', 'state_inconsistency'];
  if (criticalCategories.includes(category)) {
    return 'high';
  }

  const highCategories: FailureCategory[] = ['stream_error', 'timeout', 'network_error'];
  if (highCategories.includes(category)) {
    return 'high';
  }

  const mediumCategories: FailureCategory[] = ['element_not_found', 'validation_error'];
  if (mediumCategories.includes(category)) {
    return 'medium';
  }

  return 'low';
}

