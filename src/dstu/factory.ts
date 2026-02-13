/**
 * DSTU 资源创建工厂
 *
 * 提供高层次的资源创建便捷方法，封装了默认值设置、
 * 名称去重、元数据合并等业务逻辑。
 */

import { dstu } from './api';
import type { DstuNode, DstuNodeType } from './types';
import { EMPTY_RESOURCE_TEMPLATES } from './types';
import { getDstuLogger } from './logger';
import { generateUniqueName } from './naming';
import { Result, ok, err, toVfsError, VfsError, VfsErrorCode, reportError } from '@/shared/result';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 可创建空文件的资源类型
 *
 * 排除了文件夹、普通文件和图片，这些类型不支持通过 createEmpty 创建
 */
export type CreatableResourceType = Exclude<DstuNodeType, 'folder' | 'file' | 'image'>;

/**
 * 创建空文件选项
 */
export interface CreateEmptyOptions {
  /** 资源类型 */
  type: CreatableResourceType;
  /** 自定义名称（可选，不提供则使用默认名称） */
  name?: string;
  /** VFS 文件夹 ID（可选，用于添加到文件夹） */
  folderId?: string | null;
  /** 额外元数据（可选，合并到默认元数据） */
  extraMetadata?: Record<string, unknown>;
}

// ============================================================================
// 日志前缀
// ============================================================================

const LOG_PREFIX = '[DSTU:Factory]';

// ============================================================================
// 核心函数
// ============================================================================

/**
 * 创建空资源文件
 *
 * 统一的空文件创建流程：
 * 1. 根据类型获取默认模板
 * 2. 构建 DSTU 路径
 * 3. 调用 dstu.create 创建文件
 *
 * @param options 创建选项
 * @returns Result 包装的新创建资源节点
 *
 * @example
 * ```typescript
 * // 创建空笔记
 * const result = await createEmpty({ type: 'note' });
 * if (result.ok) {
 *   console.log('创建成功', result.value);
 * } else {
 *   reportError(result.error, '创建笔记');
 *   toast.error(result.error.toUserMessage());
 * }
 *
 * // 创建空翻译
 * const translationResult = await createEmpty({ type: 'translation' });
 * if (!translationResult.ok) {
 *   reportError(translationResult.error, '创建翻译');
 *   return;
 * }
 *
 * // 创建空题目集，指定名称和文件夹
 * const examResult = await createEmpty({
 *   type: 'exam',
 *   name: '期末模拟卷',
 *   folderId: 'fld_xxx',
 * });
 * if (!examResult.ok) {
 *   reportError(examResult.error, '创建题目集');
 *   toast.error(examResult.error.toUserMessage());
 * }
 * ```
 */
export async function createEmpty(options: CreateEmptyOptions): Promise<Result<DstuNode, VfsError>> {
  const startTime = Date.now();
  const logger = getDstuLogger();
  logger.call('createEmpty', options);

  const { type, name, folderId, extraMetadata } = options;

  // 获取默认模板
  const template = EMPTY_RESOURCE_TEMPLATES[type];
  if (!template) {
    const error = new VfsError(
      VfsErrorCode.VALIDATION,
      `未知的资源类型: ${type}`,
      false,
      { type }
    );
    logger.error('createEmpty', error.message, [options]);
    reportError(error, '创建空资源');
    return err(error);
  }

  const path = '/';

  // 确定最终名称
  let finalName = name;

  // 如果未指定名称，使用默认名称并进行去重
  if (!finalName) {
    const defaultName = template.defaultName;

    // 查询同类型资源列表，使用 typeFilter 参数
    const listResult = await dstu.list('/', {
      limit: 1000, // 获取足够多的资源进行去重检查
      typeFilter: type,
    });

    if (!listResult.ok) {
      // 如果查询失败，回退到默认名称（首次创建时可能目录不存在）
      console.warn(LOG_PREFIX, 'Failed to list existing resources for name dedup, using default name:', listResult.error.message);
      finalName = defaultName;
    } else {
      // 提取所有现有名称
      const existingNames = listResult.value.map((node) => node.name);

      // 生成唯一名称
      finalName = generateUniqueName(defaultName, existingNames);

      logger.call('createEmpty.generateUniqueName', {
        defaultName,
        existingCount: existingNames.length,
        generatedName: finalName,
      });
    }
  }

  // 合并元数据
  const metadata: Record<string, unknown> = {
    ...template.metadata,
    ...extraMetadata,
  };

  // 如果指定了文件夹，添加到元数据
  if (folderId !== undefined) {
    metadata.folderId = folderId;
  }

  logger.call('createEmpty.dstu.create', { path, type, name: finalName, metadata });

  // 创建资源
  const createResult = await dstu.create(path, {
    type,
    name: finalName,
    content: template.content,
    metadata,
  });

  if (!createResult.ok) {
    logger.error('createEmpty', createResult.error.message, [options]);
    reportError(createResult.error, '创建空资源');
    return createResult;
  }

  logger.success('createEmpty', createResult.value, Date.now() - startTime);
  return createResult;
}
