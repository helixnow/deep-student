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

// ★ 2026-07-08（审计 30-P1-4）：graphApi（1455 行，模块自述已废弃）从 barrel 静态导出中摘除，
// 避免被 App.tsx 等静态导入 TauriAPI 的调用方拖进首屏 chunk。
// 全仓仅 NoTagTreeShadPanel 仍引用下面两个函数，以动态 import 包装保持 TauriAPI.xxx 调用契约。
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
