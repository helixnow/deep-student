// tauriApi.ts — Barrel re-export file
// 从各子模块重导出所有公开 API，保持外部 import 路径不变

export * from './shared';
export * from './types';
export * from './chatApi';
export * from './settingsApi';
export * from './configApi';
export * from './graphApi';
export * from './systemApi';
export * from './testApi';

// 重建 TauriAPI 对象，保持 TauriAPI.method() 调用方式的向后兼容
import * as _chatApi from './chatApi';
import * as _settingsApi from './settingsApi';
import * as _configApi from './configApi';
import * as _graphApi from './graphApi';
import * as _systemApi from './systemApi';
import * as _testApi from './testApi';

export const TauriAPI = {
  ..._chatApi,
  ..._settingsApi,
  ..._configApi,
  ..._graphApi,
  ..._systemApi,
  ..._testApi,
  invoke: _chatApi.tauriInvoke,
};
