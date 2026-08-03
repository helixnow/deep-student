// tauriApi.ts — Barrel re-export file
// 从各子模块重导出所有公开 API，保持外部 import 路径不变

export * from './shared';
export * from './types';
export * from './chatApi';
export * from './settingsApi';
export * from './configApi';
export * from './systemApi';
export * from './testApi';

// 重建 TauriAPI 对象，保持 TauriAPI.method() 调用方式的向后兼容
import * as _chatApi from './chatApi';
import * as _settingsApi from './settingsApi';
import * as _configApi from './configApi';
import * as _systemApi from './systemApi';
import * as _testApi from './testApi';

// ## Deprecation inventory (graphApi barrel)
// - owner: knowledge-graph
// - status: 禁止 `export * from './graphApi'` 静态 barrel（2026-07-08 已摘除）
// - keep (live callers, 2026-07-20 rg):
//   - TauriAPI 动态包装 → NoTagTreeShadPanel（下面两个 stream API）
//   - `@/utils/graphApi` 直接 import → quick-assistant/service.ts（bulkImportProblemCards）
// - remove target: 待上述调用方迁出后可删 graphApi.ts 本体（不可在仍有动态/静态引用时删）
const unifiedImportTagHierarchyStream = async (
  ...args: Parameters<typeof import('./graphApi')['unifiedImportTagHierarchyStream']>
): Promise<string> => (await import('./graphApi')).unifiedImportTagHierarchyStream(...args);

const unifiedGenerateTagHierarchyPreviewStream = async (
  ...args: Parameters<typeof import('./graphApi')['unifiedGenerateTagHierarchyPreviewStream']>
): Promise<string> => (await import('./graphApi')).unifiedGenerateTagHierarchyPreviewStream(...args);

export const TauriAPI = {
  ..._chatApi,
  ..._settingsApi,
  ..._configApi,
  ..._systemApi,
  ..._testApi,
  unifiedImportTagHierarchyStream,
  unifiedGenerateTagHierarchyPreviewStream,
  invoke: _chatApi.tauriInvoke,
};
