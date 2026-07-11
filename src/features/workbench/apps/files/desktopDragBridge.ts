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
  normalizeWorkbenchResourceDragData,
  parseWorkbenchDragData,
  resolveWorkbenchDesktopDropPoint,
  setWorkbenchDragData,
  WB_RESOURCE_MIME,
  type WorkbenchDropPoint,
  type WorkbenchResourceDragData,
} from '../../hooks/useDesktopDrop';
import { workbenchBus } from '../../core/workbenchBus';
import { announceWorkbench } from '../../hooks/useWorkbenchA11y';
import { resourceTypeToAppTypeId } from '../content/typeMap';

function announceDropOpened(resource: WorkbenchResourceDragData): void {
  const title = resource.title;
  announceWorkbench(
    i18n.t('workbench:a11y.dropOpened', {
      title,
      defaultValue: `已打开 ${title}`,
    }),
  );
}

export {
  WB_RESOURCE_MIME,
  normalizeWorkbenchResourceDragData,
  parseWorkbenchDragData,
  resolveWorkbenchDesktopDropPoint,
  setWorkbenchDragData,
};
export type { WorkbenchResourceDragData, WorkbenchDropPoint };

function normalizeDropPoint(point: WorkbenchDropPoint | undefined): WorkbenchDropPoint | undefined {
  try {
    return point &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      Number.isFinite(point.clientX) &&
      Number.isFinite(point.clientY)
      ? { x: point.x, y: point.y, clientX: point.clientX, clientY: point.clientY }
      : undefined;
  } catch {
    return undefined;
  }
}

export interface DesktopResourceDropContext {
  resource: WorkbenchResourceDragData;
  point?: WorkbenchDropPoint;
  /** 拖源窗口 id（若可知） */
  sourceWindowId?: string | null;
}

export type DesktopResourceDropHandler = (
  ctx: DesktopResourceDropContext,
) => boolean | Promise<boolean>;

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
  point?: WorkbenchDropPoint,
): string | null {
  const normalized = normalizeWorkbenchResourceDragData(resource);
  if (!normalized) return null;
  const typeId = resourceTypeToAppTypeId(normalized.resourceType);
  if (!typeId) return null;
  const normalizedPoint = normalizeDropPoint(point);
  return workbenchBus.launch({
    typeId,
    instanceKey: normalized.resourceId,
    dropPoint: normalizedPoint
      ? { x: normalizedPoint.x, y: normalizedPoint.y }
      : undefined,
    // core LaunchReason 未扩 desktop-drop；与 files 双击开窗同语义
    reason: 'files',
  });
}

/**
 * 处理桌面资源落点：仅 handler 明确返回 true 时视为认领；未注册、
 * 返回 false/void 或抛错时均兜底 launch。返回是否最终处理成功。
 */
export async function handleDesktopResourceDrop(
  ctx: DesktopResourceDropContext,
): Promise<boolean> {
  let resource: WorkbenchResourceDragData | null = null;
  let point: WorkbenchDropPoint | undefined;
  let sourceWindowId: string | null = null;
  try {
    resource = normalizeWorkbenchResourceDragData(ctx.resource);
    point = normalizeDropPoint(ctx.point);
    sourceWindowId = ctx.sourceWindowId ?? null;
  } catch {
    return false;
  }
  if (!resource) return false;
  const normalizedCtx: DesktopResourceDropContext = {
    resource,
    point,
    sourceWindowId,
  };

  const handler = registeredHandler;
  if (handler) {
    try {
      const result = await handler(normalizedCtx);
      if (result === true) return true;
    } catch (error) {
      console.error('[workbench:drop] desktop resource handler failed; using fallback', error);
    }
  }
  try {
    const opened = launchResourceFromDragData(resource, point) !== null;
    if (opened) announceDropOpened(resource);
    return opened;
  } catch (error) {
    console.error('[workbench:drop] resource launch fallback failed', error);
    return false;
  }
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
