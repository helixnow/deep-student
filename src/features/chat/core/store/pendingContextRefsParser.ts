/**
 * pendingContextRefsJson 三级降级解析（从 restoreActions.restoreFromBackend 抽出）
 *
 * 🛡️ 鲁棒性策略（行为与抽出前一致）：
 * 1. 标准 JSON.parse
 * 2. 逐个元素解析（处理数组部分损坏）
 * 3. 字符串扫描提取 ContextRef 对象（安全的非正则方法，防止 ReDoS）
 *
 * 本模块保持纯函数（不触碰 store / i18n / 通知），便于单测；
 * 解析结果的用户通知与技能引用迁移由调用方（restoreActions）负责。
 */
import type { ContextRef } from '../../context/types';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export type PendingRefsParseResult = 'success' | 'partial' | 'failed';

export interface PendingRefsParseStats {
  originalLength: number;
  parsedCount: number;
  failedCount: number;
  method: 'standard' | 'incremental' | 'string-scan' | 'none';
}

export interface ParsedPendingContextRefs {
  refs: ContextRef[];
  parseResult: PendingRefsParseResult;
  stats: PendingRefsParseStats;
}

/** 验证 ContextRef 有效性（必需字段 + resourceId / hash 格式） */
export function isValidContextRef(obj: unknown): obj is ContextRef {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  const ref = obj as Record<string, unknown>;

  // 检查必需字段
  if (typeof ref.resourceId !== 'string' || !ref.resourceId.trim()) {
    return false;
  }
  if (typeof ref.hash !== 'string' || !ref.hash.trim()) {
    return false;
  }
  if (typeof ref.typeId !== 'string' || !ref.typeId.trim()) {
    return false;
  }

  // 额外验证：resourceId 格式（res_{nanoid(10)}）
  if (!/^res_[a-zA-Z0-9_-]{10}$/.test(ref.resourceId)) {
    console.warn('[ChatStore] Invalid resourceId format:', ref.resourceId);
    return false;
  }

  // 额外验证：hash 格式（SHA-256 hex）
  if (!/^[a-f0-9]{64}$/.test(ref.hash)) {
    console.warn('[ChatStore] Invalid hash format:', ref.hash);
    return false;
  }

  return true;
}

/** 第二级：逐个提取顶层 {...} 对象后单独解析（处理数组部分损坏） */
function parseIncremental(jsonStr: string, stats: PendingRefsParseStats): ContextRef[] {
  const trimmed = jsonStr.trim();

  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new Error('Not an array format');
  }

  const arrayContent = trimmed.slice(1, -1).trim();
  if (!arrayContent) {
    // 空数组：合法输入，返回空集
    return [];
  }

  // 查找所有顶层的 {...} 对象（深度计数，避免正则）
  const objectMatches: string[] = [];
  let depth = 0;
  let startIdx = -1;

  for (let i = 0; i < arrayContent.length; i++) {
    const char = arrayContent[i];
    if (char === '{') {
      if (depth === 0) {
        startIdx = i;
      }
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && startIdx !== -1) {
        objectMatches.push(arrayContent.substring(startIdx, i + 1));
        startIdx = -1;
      }
    }
  }

  if (objectMatches.length === 0) {
    throw new Error('No object patterns found');
  }

  const refs: ContextRef[] = [];
  for (const objStr of objectMatches) {
    try {
      const obj = JSON.parse(objStr);
      if (isValidContextRef(obj)) {
        refs.push(obj);
        stats.parsedCount++;
      } else {
        stats.failedCount++;
        console.warn('[ChatStore] Invalid ContextRef object:', obj);
      }
    } catch (itemError) {
      stats.failedCount++;
      console.warn('[ChatStore] Failed to parse individual item:', objStr, itemError);
    }
  }

  if (refs.length === 0) {
    throw new Error('No valid objects found in incremental parse');
  }
  return refs;
}

/**
 * 第三级：字符串扫描提取 ContextRef（安全的非正则方法）
 *
 * 安全设计说明：
 * 1. 完全避免复杂正则表达式，防止 ReDoS 攻击
 * 2. 使用简单的字符扫描，时间复杂度 O(n)
 * 3. 添加超时保护机制，防止长时间运行
 * 4. 对每个候选对象进行安全的 JSON 解析
 */
function parseByStringScan(jsonString: string, stats: PendingRefsParseStats): ContextRef[] {
  const scanStartTime = performance.now();
  const SCAN_TIMEOUT_MS = 5000; // 5秒超时保护

  const refs: ContextRef[] = [];
  let i = 0;
  let objectsScanned = 0;
  const maxObjectsToScan = 10000; // 最多扫描10000个对象，防止无限循环

  while (i < jsonString.length) {
    if (performance.now() - scanStartTime > SCAN_TIMEOUT_MS) {
      console.warn('[ChatStore] ⚠️ String scanning timeout, returning partial results');
      break;
    }
    if (objectsScanned >= maxObjectsToScan) {
      console.warn('[ChatStore] ⚠️ Max objects scanned limit reached, returning partial results');
      break;
    }

    const start = jsonString.indexOf('{', i);
    if (start === -1) break;

    // 查找匹配的结束大括号（深度计数）；单对象最多扫描 1000 字符
    let depth = 0;
    let end = start;
    let foundEnd = false;
    const maxScanLength = 1000;
    const scanLimit = Math.min(start + maxScanLength, jsonString.length);

    for (let j = start; j < scanLimit; j++) {
      const char = jsonString[j];
      if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          end = j + 1;
          foundEnd = true;
          break;
        }
      }
    }

    if (foundEnd) {
      const candidate = jsonString.substring(start, end);
      objectsScanned++;

      // 快速预检：必须包含所有必需字段
      if (
        candidate.includes('"resourceId"') &&
        candidate.includes('"hash"') &&
        candidate.includes('"typeId"')
      ) {
        try {
          const obj = JSON.parse(candidate);
          if (isValidContextRef(obj)) {
            refs.push(obj);
            stats.parsedCount++;
          } else {
            stats.failedCount++;
          }
        } catch {
          stats.failedCount++;
        }
      }

      i = end;
    } else {
      i = start + 1;
    }
  }

  const scanDuration = performance.now() - scanStartTime;
  if (refs.length > 0) {
    console.log('[ChatStore] ✅ Restored pendingContextRefs (string-scan):', {
      total: refs.length,
      failed: stats.failedCount,
      durationMs: scanDuration.toFixed(2),
      performance: scanDuration < 100 ? '🚀 excellent' : scanDuration < 500 ? '✅ good' : '⚠️ slow',
    });
  }
  return refs;
}

/**
 * 解析持久化的 pendingContextRefsJson，逐级降级直到提取出有效引用。
 *
 * - parseResult === 'success'：标准解析成功（允许过滤掉个别无效元素），
 *   或增量解析成功且没有任何失败元素
 * - parseResult === 'partial'：增量解析有失败元素，或走到字符串扫描
 * - parseResult === 'failed'：三级全部失败，refs 为空
 */
export function parsePendingContextRefsJson(raw: string): ParsedPendingContextRefs {
  const stats: PendingRefsParseStats = {
    originalLength: raw.length,
    parsedCount: 0,
    failedCount: 0,
    method: 'none',
  };

  // ━━━ 第一级：标准 JSON.parse ━━━
  let standardError: unknown;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('Parsed result is not an array');
    }
    const validated = parsed.filter((item: unknown): item is ContextRef => isValidContextRef(item));
    stats.parsedCount = validated.length;
    stats.failedCount = parsed.length - validated.length;
    stats.method = 'standard';
    console.log('[ChatStore] ✅ Restored pendingContextRefs (standard):', {
      total: validated.length,
      failed: stats.failedCount,
    });
    return { refs: validated, parseResult: 'success', stats };
  } catch (error) {
    standardError = error;
    console.warn('[ChatStore] ⚠️ Standard JSON.parse failed, trying incremental parse...', error);
  }

  // ━━━ 第二级：逐个元素解析 ━━━
  let incrementalError: unknown;
  try {
    const refs = parseIncremental(raw, stats);
    stats.method = 'incremental';
    const parseResult: PendingRefsParseResult = stats.failedCount > 0 ? 'partial' : 'success';
    console.log('[ChatStore] ✅ Restored pendingContextRefs (incremental):', {
      total: refs.length,
      failed: stats.failedCount,
    });
    return { refs, parseResult, stats };
  } catch (error) {
    incrementalError = error;
    console.warn('[ChatStore] ⚠️ Incremental parse failed, trying string scanning extraction...', error);
  }

  // ━━━ 第三级：字符串扫描提取 ━━━
  try {
    const refs = parseByStringScan(raw, stats);
    if (refs.length === 0) {
      throw new Error('No valid refs extracted by string scanning');
    }
    stats.method = 'string-scan';
    // 字符串扫描一定是部分恢复
    return { refs, parseResult: 'partial', stats };
  } catch (scanError) {
    stats.method = 'none';
    console.error('[ChatStore] ❌ All parse methods failed:', {
      standardError,
      incrementalError,
      scanError,
      originalJson: raw.substring(0, 500) + '...', // 只记录前500字符
    });
    return { refs: [], parseResult: 'failed', stats };
  }
}
