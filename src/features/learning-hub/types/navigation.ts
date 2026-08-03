/**
 * Learning Hub 导航相关类型（与 finderStore.BreadcrumbItem 字段刻意分层）
 */

/** 面包屑项（真实路径版） */
export interface RealPathBreadcrumbItem {
  /** 文件夹 ID，null 表示根目录 */
  folderId: string | null;
  /** 文件夹名称 */
  name: string;
  /** 完整路径 */
  fullPath: string;
}
