import React from 'react';
import { AppIconImage } from '../../icons/appIcons';
import { appRegistry } from '../../core/appRegistry';
import type { ActivationContext, ActivationResult, AppDefinition } from '../../core/types';
import { FILE_PREVIEW_APP_TYPE_ID } from '../content/typeMap';
import { createResourceContentManifest } from '../content/agentManifests';
import { requestPdfPageFocus } from '../content/pdfFocusAck';

const FilePreviewAppWindow = React.lazy(() => import('./FilePreviewAppWindow'));

function parsePage(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const value = record.page ?? record.pageNumber;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

export async function handleFilePreviewActivation(ctx: ActivationContext): Promise<ActivationResult> {
  if (ctx.action !== 'scrollToHeading' && ctx.action !== 'gotoPage') {
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
      hint: `file-preview ${ctx.action} 需要 instanceKey 和 payload.page`,
    };
  }

  return requestPdfPageFocus(ctx.instanceKey, page);
}

export const FILE_PREVIEW_APP_DEFINITION: AppDefinition = {
  typeId: FILE_PREVIEW_APP_TYPE_ID,
  nameKey: 'workbench:apps.filePreview',
  icon: React.createElement(AppIconImage, { typeId: 'file-preview', className: 'h-8 w-8' }),
  showInLauncher: false,
  instanceMode: 'multi',
  memoryWeight: 3,
  defaultFrame: { w: 920, h: 700 },
  minSize: { w: 420, h: 320 },
  render: FilePreviewAppWindow,
  onActivation: handleFilePreviewActivation,
  agentManifest: createResourceContentManifest(
    FILE_PREVIEW_APP_TYPE_ID,
    handleFilePreviewActivation,
  ),
};

appRegistry.register(FILE_PREVIEW_APP_DEFINITION);
