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
import { hasContentSaveHandler, isContentDirty, saveContentNow } from './contentDirtyRegistry';
import { requestContentCloseDecision } from './ContentCloseConfirmation';
import { getResourceWorkspaceActive } from './resourceWorkspaceRegistry';
import { showGlobalNotification } from '@/components/UnifiedNotification';

export interface CreateContentAppOptions {
  typeId: ContentAppTypeId;
  /** i18n key in the workbench namespace. */
  nameKey: string;
  icon: React.ReactNode;
  /** Whether this app can be launched without selecting a resource first. */
  showInLauncher?: boolean;
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

  // canClose / canSuspend 共用的 dirty 目标解析：exam/essay/translation 是
  // 单窗 workspace（instanceKey 为 null），dirty 挂在当前激活的资源上。
  const resolveDirtyResourceId = (instanceKey: string | null): string | null =>
    instanceKey ?? (
      typeId === 'exam' || typeId === 'essay' || typeId === 'translation'
        ? getResourceWorkspaceActive(typeId)
        : null
    );

  const canClose = options.confirmUnsavedOnClose
    ? async (instanceKey: string | null): Promise<boolean> => {
        const dirtyResourceId = resolveDirtyResourceId(instanceKey);
        if (!isContentDirty(typeId, dirtyResourceId)) return true;
        // 有保存挂点时提供「保存并关闭」（translation 等编辑视图注册）
        const offerSave = hasContentSaveHandler(typeId, dirtyResourceId);
        const decision = await requestContentCloseDecision({
          description: i18next.t('workbench:content.confirmCloseUnsaved'),
          offerSave,
        });
        if (decision === 'save') {
          const saved = await saveContentNow(typeId, dirtyResourceId);
          if (!saved) {
            // 保存失败不放行关闭；轻提示 + 视图侧错误 UI 展示细节
            showGlobalNotification('error', i18next.t('workbench:content.saveAndCloseFailed'));
          }
          return saved;
        }
        return decision === 'discard';
      }
    : undefined;

  // suspend 契约：dirty 窗永不 frozen。调度器热路径同步调用本回调，
  // isContentDirty 是同步查询，返回 false 即告知调度器跳过冻结
  //（脏窗保持 background，不丢未保存的内存态）。
  // 不随 confirmUnsavedOnClose 开关：exam 的关窗拦截在 register.ts 另行
  // 覆盖 canClose，但其 dirty checker 同样注册在 contentDirtyRegistry，
  // 冻结保护必须一致生效；未注册 checker 的类型恒判干净，行为不变。
  const canSuspend = (instanceKey: string | null): boolean =>
    !isContentDirty(typeId, resolveDirtyResourceId(instanceKey));

  return {
    typeId,
    nameKey: options.nameKey,
    icon: options.icon,
    showInLauncher: options.showInLauncher,
    instanceMode: options.instanceMode ?? 'multi',
    memoryWeight: options.memoryWeight,
    defaultFrame: options.defaultFrame,
    minSize: options.minSize ?? DEFAULT_MIN_SIZE,
    render,
    canClose,
    canSuspend,
    onActivation: options.onActivation,
  };
}
