/**
 * ACR 4.0（A7）— 内容窗 agent 表面注册表
 *
 * translation / essay / image 等内容视图在挂载期把「真实可得」的观察投影
 * 与可编程动作注册到这里；manifest 的 observe/execute 只消费已注册表面，
 * 视图未挂载即诚实报告不可用（不伪造观察，不假成功）。
 *
 * key = `${typeId}:${resourceId}`。视图卸载时必须调用返回的注销函数。
 */
import type { AgentJsonValue } from '../../core/types';

export interface ContentSurfaceActionResult {
  handled: boolean;
  changed?: boolean;
  code?: string;
  hint?: string;
}

export interface ImageZoomState {
  /** 实际像素缩放百分比（100 = 1:1），四舍五入 */
  zoomPercent: number;
  fitMode: boolean;
}

/** A45-5：图片顺时针旋转增量（度）；与视图 90° 步进语义对齐 */
export type ImageRotateDegrees = 90 | 180 | 270;

export interface ContentAgentSurface {
  /** JSON-only 摘要投影，合并进 observe().state.content；必须真实可得 */
  getSummary: () => Record<string, AgentJsonValue>;
  /** image：设置缩放（10–800 的百分比，或 'fit' 适应窗口） */
  setZoom?: (zoom: number | 'fit') => ContentSurfaceActionResult;
  /** image：undo 用的当前缩放态读数 */
  getZoomState?: () => ImageZoomState;
  /**
   * A45-5（docs/dev/acr/ACR-4.5.md）image：顺时针旋转 90/180/270 度。
   * 视图态操作，不修改图片文件；视图未挂载时表面不存在，manifest 诚实失败。
   */
  rotate?: (degrees: ImageRotateDegrees) => ContentSurfaceActionResult;
  /** A45-5 image：当前归一化旋转角读数（0/90/180/270，顺时针），回执 details 用 */
  getRotation?: () => number;
}

const surfaces = new Map<string, ContentAgentSurface>();

function surfaceKey(typeId: string, resourceId: string): string {
  return `${typeId}:${resourceId}`;
}

/** 注册内容表面；返回注销函数（仅当仍指向本次注册时移除，防止晚到清理误删新表面） */
export function registerContentAgentSurface(
  typeId: string,
  resourceId: string,
  surface: ContentAgentSurface,
): () => void {
  const key = surfaceKey(typeId, resourceId);
  surfaces.set(key, surface);
  return () => {
    if (surfaces.get(key) === surface) {
      surfaces.delete(key);
    }
  };
}

export function getContentAgentSurface(
  typeId: string,
  resourceId: string | null | undefined,
): ContentAgentSurface | null {
  if (!resourceId) return null;
  return surfaces.get(surfaceKey(typeId, resourceId)) ?? null;
}
