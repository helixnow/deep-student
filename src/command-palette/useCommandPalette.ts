/**
 * 命令面板 Hook
 * 提供便捷的命令面板操作接口
 */

export { useCommandPalette } from './CommandPaletteProvider';

// 重新导出类型
export type { DependencyResolver, Command, CommandCategory } from './registry/types';
