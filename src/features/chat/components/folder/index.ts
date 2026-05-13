/**
 * Chat V2 - Folder 组件导出
 *
 * 文件夹注入相关 UI 组件
 *
 * 数据契约来源：23-VFS文件夹架构与上下文注入改造任务分配.md Prompt 9
 */

// FolderSelector 选择器弹窗
export { FolderSelector } from './FolderSelector';
export type { FolderSelectorProps } from './FolderSelector';

// FolderContextChip 上下文芯片
export {
  FolderContextChip,
  FolderContextChipList,
} from './FolderContextChip';
export type {
  FolderContextChipProps,
  FolderContextChipListProps,
} from './FolderContextChip';
