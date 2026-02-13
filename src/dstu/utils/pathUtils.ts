/**
 * DSTU 纯前端路径工具
 *
 * 数据契约来源：28-DSTU真实路径架构重构任务分配.md 契约 D3
 *
 * 约束：
 * 1. 所有方法为纯函数，不调用后端
 * 2. 支持新路径格式（/{folder_path}/{resource_id}）
 */

import type { ParsedPath, PathUtils } from '../types/path';
import {
  MAX_RESOURCE_ID_LENGTH,
  RESOURCE_ID_PREFIX_MAP,
  VIRTUAL_PATH_PREFIXES,
} from '../types/path';

// ============================================================================
// 内部辅助函数
// ============================================================================

/**
 * 检测 Unicode 绕过字符
 * 与后端 folder_handlers.rs 的 contains_unicode_bypass_chars 保持一致
 * 
 * 这些字符可能被用于绕过路径验证：
 * - 全角斜杠：在某些系统上可能被规范化为普通斜杠
 * - 零宽字符：可能导致视觉欺骗或绕过字符串匹配
 */
function containsUnicodeBypassChars(s: string): boolean {
  const dangerousChars = [
    '\u{FF0F}',  // 全角斜杠 ／
    '\u{FF3C}',  // 全角反斜杠 ＼
    '\u{2044}',  // 分数斜杠 ⁄
    '\u{2215}',  // 除法斜杠 ∕
    '\u{29F8}',  // 大斜杠 ⧸
    '\u{200B}',  // 零宽空格
    '\u{200C}',  // 零宽非连接符
    '\u{200D}',  // 零宽连接符
    '\u{FEFF}',  // 零宽非断空格 (BOM)
  ];
  return dangerousChars.some(char => s.includes(char));
}

/**
 * 从资源 ID 前缀推断资源类型
 * 
 * [PATH-006] 添加长度限制检查
 */
function inferResourceType(id: string): string | null {
  // [PATH-006] 资源 ID 长度限制检查
  if (id.length > MAX_RESOURCE_ID_LENGTH) {
    return null;
  }
  
  for (const [prefix, type] of Object.entries(RESOURCE_ID_PREFIX_MAP)) {
    if (id.startsWith(prefix)) {
      return type;
    }
  }
  return null;
}

/**
 * 检查是否为资源 ID（带有已知前缀）
 */
function isResourceId(segment: string): boolean {
  return inferResourceType(segment) !== null;
}

/**
 * 验证资源 ID 是否有效
 * 
 * [PATH-006] 检查资源 ID 的前缀和长度
 * 
 * @param id 资源 ID
 * @returns 验证结果，包含是否有效和错误消息
 */
function validateResourceId(id: string): { valid: boolean; error?: string } {
  if (!id) {
    return { valid: false, error: '资源ID不能为空' };
  }
  
  // [PATH-006] 长度限制检查
  if (id.length > MAX_RESOURCE_ID_LENGTH) {
    return { 
      valid: false, 
      error: `资源ID长度超限: ${id.length} 字符（最大 ${MAX_RESOURCE_ID_LENGTH}）` 
    };
  }
  
  // 前缀检查
  const resourceType = inferResourceType(id);
  if (!resourceType) {
    return { valid: false, error: '资源ID格式无效：缺少有效前缀' };
  }
  
  return { valid: true };
}

/**
 * 检查是否为虚拟路径
 */
function checkIsVirtualPath(path: string): boolean {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return Object.values(VIRTUAL_PATH_PREFIXES).some(prefix => 
    normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  );
}


// ============================================================================
// 路径解析
// ============================================================================

/**
 * 解析 DSTU 路径
 *
 * 支持格式：/{folder_path}/{resource_id}
 * 例如：/高考复习/函数/note_abc123
 *
 * @param path 路径字符串
 * @returns 解析结果
 */
function parse(path: string): ParsedPath {
  // 标准化路径
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  
  // 处理根目录
  if (normalizedPath === '/') {
    return {
      fullPath: '/',
      folderPath: null,
      resourceId: null,
      id: null,
      resourceType: null,
      isRoot: true,
      isVirtual: false,
    };
  }
  
  // 处理虚拟路径
  if (checkIsVirtualPath(normalizedPath)) {
    const segments = normalizedPath.split('/').filter(Boolean);
    const virtualType = segments[0]; // @trash, @recent 等
    
    // 虚拟路径下可能有资源 ID
    if (segments.length > 1) {
      const lastSegment = segments[segments.length - 1];
      const resourceType = inferResourceType(lastSegment);
      
      const resId = resourceType ? lastSegment : null;
      return {
        fullPath: normalizedPath,
        folderPath: `/${virtualType}`,
        resourceId: resId,
        id: resId,
        resourceType,
        isRoot: false,
        isVirtual: true,
      };
    }
    
    return {
      fullPath: normalizedPath,
      folderPath: null,
      resourceId: null,
      id: null,
      resourceType: null,
      isRoot: false,
      isVirtual: true,
    };
  }
  
  // 处理新格式路径
  const segments = normalizedPath.split('/').filter(Boolean);
  
  if (segments.length === 0) {
    return {
      fullPath: '/',
      folderPath: null,
      resourceId: null,
      id: null,
      resourceType: null,
      isRoot: true,
      isVirtual: false,
    };
  }
  
  // 检查最后一段是否为资源 ID
  const lastSegment = segments[segments.length - 1];
  const resourceType = inferResourceType(lastSegment);
  
  if (resourceType) {
    // 最后一段是资源 ID
    const folderSegments = segments.slice(0, -1);
    const folderPath = folderSegments.length > 0 ? `/${folderSegments.join('/')}` : null;
    
    return {
      fullPath: normalizedPath,
      folderPath,
      resourceId: lastSegment,
      id: lastSegment,
      resourceType,
      isRoot: false,
      isVirtual: false,
    };
  }
  
  // 最后一段不是资源 ID，整个路径是文件夹路径
  return {
    fullPath: normalizedPath,
    folderPath: normalizedPath,
    resourceId: null,
    id: null,
    resourceType: null,
    isRoot: false,
    isVirtual: false,
  };
}

// ============================================================================
// 路径构建
// ============================================================================

/**
 * 构建完整路径
 *
 * [PATH-006] 添加资源 ID 长度验证
 * 
 * @param folderPath 文件夹路径，null 表示根目录
 * @param resourceId 资源 ID
 * @returns 完整路径
 * @throws Error 当资源 ID 长度超限时
 */
function build(folderPath: string | null, resourceId: string): string {
  if (!resourceId) {
    return folderPath || '/';
  }
  
  // [PATH-006] 验证资源 ID 长度
  if (resourceId.length > MAX_RESOURCE_ID_LENGTH) {
    throw new Error(`资源ID长度超限: ${resourceId.length} 字符（最大 ${MAX_RESOURCE_ID_LENGTH}）`);
  }
  
  if (!folderPath || folderPath === '/') {
    return `/${resourceId}`;
  }
  
  // 确保 folderPath 以 / 开头
  const normalizedFolder = folderPath.startsWith('/') ? folderPath : `/${folderPath}`;
  // 移除尾部的 /
  const cleanFolder = normalizedFolder.replace(/\/+$/, '');
  
  return `${cleanFolder}/${resourceId}`;
}

// ============================================================================
// 资源类型推断
// ============================================================================

/**
 * 从资源 ID 推断资源类型
 *
 * @param id 资源 ID
 * @returns 资源类型，无法推断返回 null
 */
function getResourceType(id: string): string | null {
  return inferResourceType(id);
}

// ============================================================================
// 路径验证
// ============================================================================

/**
 * 验证路径格式是否有效
 *
 * 有效路径规则：
 * 1. 必须以 / 开头
 * 2. 不能包含连续的 /
 * 3. 不能包含特殊字符（除了 @ 用于虚拟路径）
 * 4. 不能包含路径遍历段（.. 或 .）
 * 5. 不能包含 Unicode 绕过字符
 *
 * @param path 路径字符串
 * @returns 是否有效
 */
function isValidPath(path: string): boolean {
  // 空路径无效
  if (!path) {
    return false;
  }
  
  // 必须以 / 开头
  if (!path.startsWith('/')) {
    return false;
  }
  
  // 不能包含连续的 /
  if (/\/\/+/.test(path)) {
    return false;
  }
  
  // 不允许尾斜杠（除了根路径 "/"）
  // 与后端 path_parser.rs 的 is_valid_path 保持一致
  if (path !== '/' && path.endsWith('/')) {
    return false;
  }
  
  // 检查 Unicode 绕过字符（PATH-001 安全修复）
  if (containsUnicodeBypassChars(path)) {
    return false;
  }
  
  // 检查每个段
  const segments = path.split('/').filter(Boolean);
  for (const segment of segments) {
    // 禁止路径遍历攻击（PATH-002 安全修复）
    if (segment === '..' || segment === '.') {
      return false;
    }
    
    // 段不能为空或只有空格
    if (!segment.trim()) {
      return false;
    }
    
    // 段不能包含非法字符（允许 @ 开头的虚拟路径段）
    if (segment.startsWith('@')) {
      // 虚拟路径段只能包含字母数字和下划线
      if (!/^@[a-zA-Z0-9_]+$/.test(segment)) {
        return false;
      }
    } else {
      // 普通段不能包含控制字符
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f\x7f]/.test(segment)) {
        return false;
      }
    }
  }
  
  return true;
}

// ============================================================================
// 虚拟路径检查
// ============================================================================

/**
 * 检查是否为虚拟路径
 *
 * @param path 路径字符串
 * @returns 是否为虚拟路径
 */
function isVirtualPath(path: string): boolean {
  return checkIsVirtualPath(path);
}

// ============================================================================
// 路径操作
// ============================================================================

/**
 * 获取父路径
 *
 * @param path 完整路径
 * @returns 父路径，根目录返回 null
 */
function getParentPath(path: string): string | null {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  
  // 根目录没有父路径
  if (normalizedPath === '/') {
    return null;
  }
  
  const segments = normalizedPath.split('/').filter(Boolean);
  
  // 只有一段，父路径是根目录
  if (segments.length <= 1) {
    return '/';
  }
  
  // 去掉最后一段
  const parentSegments = segments.slice(0, -1);
  return `/${parentSegments.join('/')}`;
}

/**
 * 获取路径的最后一段（文件名/资源 ID）
 *
 * @param path 完整路径
 * @returns 最后一段，根目录返回空字符串
 */
function getBasename(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  
  if (normalizedPath === '/') {
    return '';
  }
  
  const segments = normalizedPath.split('/').filter(Boolean);
  return segments[segments.length - 1] || '';
}

/**
 * 连接路径段
 *
 * @param segments 路径段数组
 * @returns 完整路径
 */
function join(...segments: string[]): string {
  const parts: string[] = [];
  
  for (const segment of segments) {
    if (!segment) continue;
    
    // 移除首尾的 /
    const cleaned = segment.replace(/^\/+|\/+$/g, '');
    if (cleaned) {
      parts.push(cleaned);
    }
  }
  
  if (parts.length === 0) {
    return '/';
  }
  
  return `/${parts.join('/')}`;
}

// ============================================================================
// 导出
// ============================================================================

/**
 * DSTU 路径工具集
 *
 * 纯前端路径操作工具，不调用后端
 *
 * @example
 * ```typescript
 * import { pathUtils } from '@/dstu/utils/pathUtils';
 *
 * // 解析路径
 * const parsed = pathUtils.parse('/高考复习/函数/note_abc');
 * // { fullPath: '/高考复习/函数/note_abc', folderPath: '/高考复习/函数', resourceId: 'note_abc', ... }
 *
 * // 构建路径
 * const path = pathUtils.build('/高考复习', 'note_abc');
 * // '/高考复习/note_abc'
 *
 * // 获取资源类型
 * const type = pathUtils.getResourceType('note_abc123');
 * // 'note'
 * ```
 */
export const pathUtils: PathUtils = {
  parse,
  build,
  getResourceType,
  isValidPath,
  isVirtualPath,
  getParentPath,
  getBasename,
  join,
};

// 单独导出各函数，方便 tree-shaking
export {
  parse as parsePath,
  build as buildPath,
  getResourceType,
  isValidPath,
  isVirtualPath,
  getParentPath,
  getBasename,
  join as joinPath,
  validateResourceId,
};

// 重导出常量
export { MAX_RESOURCE_ID_LENGTH } from '../types/path';

