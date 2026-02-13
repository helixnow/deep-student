/**
 * VFS 引用模式 API - 重导出模块
 *
 * ⚠️ 此文件为兼容层，实际实现在 @/chat-v2/context/vfsRefApi
 *
 * 统一入口：所有 VFS 引用 API 均从 @/chat-v2/context 导出
 *
 * @see src/chat-v2/context/vfsRefApi.ts - 唯一实现
 * @see 24-LRFS统一入口模型与访达式资源管理器.md - 契约 C
 */

// 重导出所有 API
export {
  vfsRefApi,
  // Result 版本（主要 API）
  getResourceRefsV2,
  resolveResourceRefsV2,
  getResourcePathV2,
  updatePathCacheV2,
  // 其他
  createSingleResourceRefData,
  uploadAttachment,
} from '@/chat-v2/context/vfsRefApi';

// 重导出类型
export type { VfsRefApiType } from '@/chat-v2/context/vfsRefApi';
