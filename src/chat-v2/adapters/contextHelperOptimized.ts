/**
 * 优化的上下文发送辅助函数（HIGH-008, MEDIUM-003修复）
 *
 * 改进：
 * - 使用自适应并发控制替代固定并发数
 * - 添加超时保护防止永久阻塞
 * - 保持与原有API的兼容性
 */

import { AdaptiveConcurrencyLimiter, withTimeout } from '../../utils/concurrency';
import { contextTypeRegistry } from '../context/registry';
import type { ContextRef, SendContextRef } from '../resources/types';
import type { FormatOptions } from '../context/types';
import { resourceStoreApi } from '../resources';
import { logAttachment } from '../debug/chatV2Logger';
import { getErrorMessage } from '../../utils/errorUtils';
import { resolveVfsRefs } from './contextHelper';
import { isErr } from '../../shared/result';

const LOG_PREFIX = '[ChatV2:ContextHelperOptimized]';

// ============================================================================
// 自适应并发配置（HIGH-008修复）
// ============================================================================

/**
 * 全局自适应并发限制器
 *
 * 配置说明：
 * - minConcurrency: 2 - 即使在慢速环境也保证2个并发
 * - maxConcurrency: 10 - 快速环境最多10个并发
 * - initialConcurrency: 3 - 初始保守值
 * - targetResponseTime: 800ms - 目标响应时间
 */
export const adaptiveLimiter = new AdaptiveConcurrencyLimiter({
  minConcurrency: 2,
  maxConcurrency: 10,
  initialConcurrency: 3,
  targetResponseTime: 800,
  adjustmentThreshold: 0.25,
  sampleWindowSize: 10,
  adjustmentInterval: 5,
});

/**
 * 资源加载超时时间（MEDIUM-003修复）
 */
const RESOURCE_LOAD_TIMEOUT_MS = 10000;

// ============================================================================
// 优化的 buildSendContextRefs
// ============================================================================

/**
 * 构建 SendContextRef 数组（优化版本）
 *
 * 优化：
 * - 使用自适应并发控制（根据性能动态调整）
 * - 添加超时保护（防止永久阻塞）
 * - 详细的性能日志
 *
 * @param contextRefs 待处理的上下文引用数组
 * @param options 格式化选项
 * @returns 格式化后的 SendContextRef 数组
 */
export async function buildSendContextRefsOptimized(
  contextRefs: ContextRef[],
  options?: FormatOptions
): Promise<SendContextRef[]> {
  if (!contextRefs || contextRefs.length === 0) {
    return [];
  }

  const startTime = performance.now();

  logAttachment('adapter', 'build_send_context_refs_optimized_start', {
    count: contextRefs.length,
    typeIds: contextRefs.map((r) => r.typeId),
    currentConcurrency: adaptiveLimiter.getCurrentConcurrency(),
  });

  // 1. 按 priority 排序
  const sortedRefs = [...contextRefs].sort((a, b) => {
    const priorityA = contextTypeRegistry.getPriority(a.typeId);
    const priorityB = contextTypeRegistry.getPriority(b.typeId);
    return priorityA - priorityB;
  });

  // 2. 并行加载资源（自适应并发 + 超时）
  const results = await Promise.all(
    sortedRefs.map((ref) =>
      adaptiveLimiter.run(async () => {
        try {
          // 2.1 从资源库获取内容（带超时）
          const timeoutResult = await withTimeout(
            resourceStoreApi.get(ref.resourceId),
            RESOURCE_LOAD_TIMEOUT_MS,
            `加载资源 ${ref.resourceId}`
          );

          // 🔧 P3修复：使用 isErr 类型守卫确保 TypeScript 正确推断错误类型
          if (isErr(timeoutResult)) {
            console.error(
              LOG_PREFIX,
              '资源加载超时:',
              ref.resourceId,
              timeoutResult.error.toUserMessage()
            );
            return null;
          }

          const resource = timeoutResult.value;

          if (!resource) {
            console.warn(
              LOG_PREFIX,
              'Resource not found, skipping:',
              ref.resourceId,
              'hash:',
              ref.hash
            );
            return null;
          }

          // 2.2 VFS 引用预解析
          // ★ 2026-02-13 修复：传递 injectModes，确保 resolveVfsRefs 能为文本模型补全 OCR
          const resolvedResource = await resolveVfsRefs(resource, ref.typeId, options, ref.injectModes);

          // 2.3 调用 formatToBlocks 格式化
          const formattedBlocks = contextTypeRegistry.formatResource(
            ref.typeId,
            resolvedResource,
            options
          );

          logAttachment(
            'adapter',
            'format_resource_done_optimized',
            {
              resourceId: ref.resourceId,
              typeId: ref.typeId,
              blocksCount: formattedBlocks.length,
              hasResolvedResources: !!resolvedResource._resolvedResources?.length,
              resolvedFound: resolvedResource._resolvedResources?.[0]?.found,
              resolvedContentLen: resolvedResource._resolvedResources?.[0]?.content?.length,
            },
            'success'
          );

          // 2.4 返回 SendContextRef
          return {
            resourceId: ref.resourceId,
            hash: ref.hash,
            typeId: ref.typeId,
            formattedBlocks,
          };
        } catch (error: unknown) {
          console.error(
            LOG_PREFIX,
            'Error processing context ref:',
            ref.resourceId,
            getErrorMessage(error)
          );
          return null;
        }
      })
    )
  );

  // 3. 过滤掉失败的资源
  const sendRefs = results.filter((ref): ref is SendContextRef => ref !== null);

  const duration = performance.now() - startTime;
  const stats = adaptiveLimiter.getStats();

  logAttachment(
    'adapter',
    'build_send_context_refs_optimized_done',
    {
      count: sendRefs.length,
      total: contextRefs.length,
      failed: contextRefs.length - sendRefs.length,
      duration: Math.round(duration),
      avgPerResource: Math.round(duration / contextRefs.length),
      concurrencyStats: {
        current: stats.currentConcurrency,
        avgResponseTime: Math.round(stats.avgResponseTime),
        successCount: stats.successCount,
        failureCount: stats.failureCount,
      },
    },
    'success'
  );

  // 开发模式下输出性能日志
  if (process.env.NODE_ENV === 'development' && contextRefs.length > 0) {
    console.log(
      `${LOG_PREFIX} [性能优化] 资源加载完成:`,
      `\n  总数=${contextRefs.length}`,
      `\n  成功=${sendRefs.length}`,
      `\n  耗时=${duration.toFixed(0)}ms`,
      `\n  平均=${(duration / contextRefs.length).toFixed(0)}ms/个`,
      `\n  并发数=${stats.currentConcurrency}`,
      `\n  平均响应时间=${stats.avgResponseTime.toFixed(0)}ms`
    );
  }

  return sendRefs;
}

/**
 * 获取当前并发统计信息
 */
export function getConcurrencyStats() {
  return adaptiveLimiter.getStats();
}

/**
 * 手动调整并发数（仅用于测试或调试）
 */
export function setConcurrency(concurrency: number): void {
  adaptiveLimiter.setConcurrency(concurrency);
}

/**
 * 重置并发统计
 */
export function resetConcurrencyStats(): void {
  adaptiveLimiter.resetStats();
}
