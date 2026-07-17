/**
 * 资源浏览器应用注册（P8）
 *
 * single 实例，weight=1（浏览器本身是轻量列表视图）。
 * 注册的同时启动资源删除联动订阅（幂等），保证只要 workbench
 * 应用群被装配，被删资源的窗口就会自动关闭——不依赖 files 窗口是否打开。
 */
import React from 'react';
import { AppIconImage } from '../../icons/appIcons';
import { appRegistry } from '../../core/appRegistry';
import type { AppDefinition } from '../../core/types';
import { startResourceSync } from './resourceSync';
import { handleFilesActivation } from './filesActivation';
import { filesAgentManifest } from './agentManifest';

/** 导出供测试断言元数据 */
export const FILES_APP_DEFINITION: AppDefinition = {
  typeId: 'files',
  nameKey: 'workbench:apps.files',
  icon: React.createElement(AppIconImage, { typeId: 'files', className: 'h-8 w-8' }),
  instanceMode: 'single',
  memoryWeight: 1,
  defaultFrame: { w: 980, h: 660 },
  minSize: { w: 480, h: 360 },
  render: React.lazy(() => import('./FilesAppWindow')),
  // R1-14：openFolder / reveal（store 在 handler 内动态 import）
  onActivation: handleFilesActivation,
  agentManifest: filesAgentManifest,
};

appRegistry.register(FILES_APP_DEFINITION);
startResourceSync();
