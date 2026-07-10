/**
 * desktopDragBridge — 拖资源出窗 → 桌面开窗 的 O19 协作接口（O17）
 *
 * O13 / 桌面落点侧可注册 drop handler；未注册时本桥兜底调用
 * workbenchBus.launch 开窗。MIME / 负载格式复用 O19：
 *   WB_RESOURCE_MIME / setWorkbenchDragData / parseWorkbenchDragData
 *
 * 本模块不改 hooks/** 与 core/**，只 import 消费。
 */
import i18n from 'i18next';
import {
  parseWorkbenchDragData,
  setWorkbenchDragData,
  WB_RESOURCE_MIME,
  type WorkbenchDropPoint,
  type WorkbenchResourceDragData,
} from '../../hooks/useDesktopDrop';
import { workbenchBus } from '../../core/workbenchBus';
import { announceWorkbench } from '../../hooks/useWorkbenchA11y';
import { resourceTypeToAppTypeId } from '../content/typeMap';

function announceDropOpened(resource: WorkbenchResourceDragData): void {
  const title = resource.title?.trim() || resource.resourceId;
  announceWorkbench(
    i18n.t('workbench:a11y.dropOpened', {
      title,
      defaultValue: `已打开 ${title}`,
    }),
  );
}

export { WB_RESOURCE_MIME, setWorkbenchDragData, parseWorkbenchDragData };
export type { WorkbenchResourceDragData, WorkbenchDropPoint };

export interface DesktopResourceDropContext {
  resource: WorkbenchResourceDragData;
  point?: WorkbenchDropPoint;
  /** 拖源窗口 id（若可知） */
  sourceWindowId?: string | null;
}

export type DesktopResourceDropHandler = (
  ctx: DesktopResourceDropContext,
) => boolean | void | Promise<boolean | void>;

let registeredHandler: DesktopResourceDropHandler | null = null;

/** O13 / 桌面侧注册落点处理；返回取消注册函数（幂等） */
export function registerDesktopResourceDropHandler(
  handler: DesktopResourceDropHandler,
): () => void {
  registeredHandler = handler;
  return () => {
    if (registeredHandler === handler) registeredHandler = null;
  };
}

/** 测试 / 热重载用：清空注册 */
export function clearDesktopResourceDropHandler(): void {
  registeredHandler = null;
}

export function getDesktopResourceDropHandler(): DesktopResourceDropHandler | null {
  return registeredHandler;
}

/**
 * 将资源拖拽负载映射为 workbench launch。
 * 不可开窗类型（folder / all 等）返回 null。
 */
export function launchResourceFromDragData(
  resource: WorkbenchResourceDragData,
): string | null {
  const typeId = resource.resourceType
    ? resourceTypeToAppTypeId(resource.resourceType)
    : null;
  if (!typeId) return null;
  return workbenchBus.launch({
    typeId,
    instanceKey: resource.resourceId,
    // core LaunchReason 未扩 desktop-drop；与 files 双击开窗同语义
    reason: 'files',
  });
}

/**
 * 处理桌面资源落点：优先走已注册 handler；未注册或 handler 返回 false
 * 时兜底 launch。返回是否已处理（开窗或 handler 认领）。
 */
export async function handleDesktopResourceDrop(
  ctx: DesktopResourceDropContext,
): Promise<boolean> {
  const handler = registeredHandler;
  if (handler) {
    const result = await handler(ctx);
    if (result !== false) return true;
  }
  const opened = launchResourceFromDragData(ctx.resource) !== null;
  if (opened) announceDropOpened(ctx.resource);
  return opened;
}

/**
 * 从 DataTransfer 解析并处理（供桌面 useDesktopDrop.onDrop 一行接入）。
 */
export async function handleDesktopDataTransferDrop(
  dataTransfer: DataTransfer,
  point?: WorkbenchDropPoint,
  sourceWindowId?: string | null,
): Promise<boolean> {
  const resource = parseWorkbenchDragData(dataTransfer);
  if (!resource) return false;
  return handleDesktopResourceDrop({ resource, point, sourceWindowId });
}
