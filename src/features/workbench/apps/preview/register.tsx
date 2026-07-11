import React from 'react';
import { GenericFileIcon } from '@/features/learning-hub/icons';
import { appRegistry } from '../../core/appRegistry';
import type { ActivationContext, ActivationResult, AppDefinition } from '../../core/types';
import { FILE_PREVIEW_APP_TYPE_ID } from '../content/typeMap';

const FilePreviewAppWindow = React.lazy(() => import('./FilePreviewAppWindow'));

function parsePage(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const value = record.page ?? record.pageNumber;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

export function handleFilePreviewActivation(ctx: ActivationContext): ActivationResult {
  if (ctx.action !== 'scrollToHeading') {
    return {
      handled: false,
      code: 'UNKNOWN_ACTION',
      hint: `file-preview 不支持 action=${ctx.action}`,
    };
  }

  const page = parsePage(ctx.payload);
  if (!ctx.instanceKey || page == null) {
    return {
      handled: false,
      code: 'INVALID_ARGS',
      hint: 'file-preview scrollToHeading 需要 instanceKey 和 payload.page',
    };
  }

  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('pdf-ref:focus', {
      detail: {
        sourceId: ctx.instanceKey,
        pageNumber: page,
        path: ctx.instanceKey.startsWith('/') ? ctx.instanceKey : `/${ctx.instanceKey}`,
      },
    }));
  }
  return { handled: true };
}

export const FILE_PREVIEW_APP_DEFINITION: AppDefinition = {
  typeId: FILE_PREVIEW_APP_TYPE_ID,
  nameKey: 'workbench:apps.filePreview',
  icon: React.createElement(GenericFileIcon, { className: 'h-full w-full' }),
  instanceMode: 'multi',
  memoryWeight: 3,
  defaultFrame: { w: 920, h: 700 },
  minSize: { w: 420, h: 320 },
  render: FilePreviewAppWindow,
  onActivation: handleFilePreviewActivation,
};

appRegistry.register(FILE_PREVIEW_APP_DEFINITION);
