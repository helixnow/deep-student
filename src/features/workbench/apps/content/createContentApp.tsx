/**
 * Content app factory (P8).
 *
 * Wraps a Learning Hub resource content view as a Workbench app definition:
 * - render is lazy-loaded through ContentAppWindow;
 * - resource-backed apps default to multi-instance mode with instanceKey = resourceId;
 * - exam/essay opt into a single workspace that selects resources internally;
 * - editing apps can opt into an unsaved-close guard via contentDirtyRegistry.
 */
import React from 'react';
import i18next from 'i18next';
import type {
  ActivationContext,
  ActivationResult,
  AppDefinition,
  Size,
} from '../../core/types';
import type { ContentAppTypeId } from './typeMap';
import { isContentDirty } from './contentDirtyRegistry';
import { requestContentCloseConfirmation } from './ContentCloseConfirmation';
import { getResourceWorkspaceActive } from './resourceWorkspaceRegistry';

export interface CreateContentAppOptions {
  typeId: ContentAppTypeId;
  /** i18n key in the workbench namespace. */
  nameKey: string;
  icon: React.ReactNode;
  memoryWeight: 1 | 2 | 3;
  instanceMode?: 'single' | 'multi';
  defaultFrame: Size;
  minSize?: Size;
  /** Editing apps check dirty state before closing. */
  confirmUnsavedOnClose?: boolean;
  /**
   * 一次性指令（如 note scrollToHeading）— R1-12 / R1-13。
   * 透传到 AppDefinition；R1-16 也可在 register 后覆盖赋值。
   */
  onActivation?: (ctx: ActivationContext) => void | ActivationResult;
}

const DEFAULT_MIN_SIZE: Size = { w: 360, h: 280 };

export function createContentApp(options: CreateContentAppOptions): AppDefinition {
  const { typeId } = options;

  const render = React.lazy(() =>
    import('./ContentAppWindow').then((mod) => ({
      default: mod.createContentWindowComponent(typeId),
    })),
  );

  const canClose = options.confirmUnsavedOnClose
    ? async (instanceKey: string | null): Promise<boolean> => {
        const dirtyResourceId = instanceKey ?? (
          typeId === 'essay' ? getResourceWorkspaceActive('essay') : null
        );
        if (!isContentDirty(typeId, dirtyResourceId)) return true;
        return requestContentCloseConfirmation({
          description: i18next.t('workbench:content.confirmCloseUnsaved', {
            defaultValue: '当前内容有未保存的修改，确定要关闭窗口吗？',
          }),
        });
      }
    : undefined;

  return {
    typeId,
    nameKey: options.nameKey,
    icon: options.icon,
    instanceMode: options.instanceMode ?? 'multi',
    memoryWeight: options.memoryWeight,
    defaultFrame: options.defaultFrame,
    minSize: options.minSize ?? DEFAULT_MIN_SIZE,
    render,
    canClose,
    onActivation: options.onActivation,
  };
}
