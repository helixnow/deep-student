import React from 'react';
import { AppIconImage } from '../../icons/appIcons';
import { appRegistry } from '../../core/appRegistry';
import type { AppDefinition } from '../../core/types';
import { canCloseNotebook, canSuspendNotebook } from './hostLifecycle';

export const NOTEBOOK_APP_TYPE_ID = 'notebook';

export const notebookAppDefinition: AppDefinition = {
  typeId: NOTEBOOK_APP_TYPE_ID,
  nameKey: 'workbench:apps.notebook',
  icon: React.createElement(AppIconImage, { typeId: NOTEBOOK_APP_TYPE_ID, className: 'h-8 w-8' }),
  showInLauncher: true,
  instanceMode: 'single',
  memoryWeight: 2,
  defaultFrame: { w: 1100, h: 760 },
  minSize: { w: 480, h: 420 },
  render: React.lazy(() => import('./NotebookAppWindow')),
  canClose: canCloseNotebook,
  canSuspend: canSuspendNotebook,
};

let registered = false;

export function registerNotebookApp(): void {
  if (registered) return;
  registered = true;
  appRegistry.register(notebookAppDefinition);
}

registerNotebookApp();
