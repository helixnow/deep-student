/**
 * DSTU Hooks 索引
 *
 * 提供各种 DSTU 操作的 React Hooks
 */

// 列表 Hook
export {
  useDstuList,
  useDstuNotes,
  useDstuTextbooks,
  useDstuExams,
  useDstuTranslations,
  useDstuEssays,
  // 文件夹优先模式 Hooks
  useDstuFolder,
  useDstuSmartFolder,
  useDstuListWithOptions,
  type UseDstuListOptions,
  type UseDstuListReturn,
} from './useDstuList';

// 资源 Hook
export {
  useDstuResource,
  useDstuCreate,
  useDstuSearch,
  type UseDstuResourceOptions,
  type UseDstuResourceReturn,
  type UseDstuCreateReturn,
  type UseDstuSearchOptions,
  type UseDstuSearchReturn,
} from './useDstuResource';
