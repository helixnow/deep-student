/**
 * W38 — App 壳层与桌面工作台之间的宿主接口（唯一静态接缝）。
 *
 * 为什么需要它：移动端构建不应包含 `src/features/workbench/**`。App / main /
 * command-palette 又需要在同步路径上读取少量工作台状态（焦点应用、脏窗、
 * apps 面板开合）。本模块只声明桥接接口并持有运行时注册的实现：
 *   - 本文件不 import 任何 `src/features/workbench/**` 的运行时代码；
 *   - 桌面实现由 `./host-runtime` 动态注册（`./load` 中的平台字面量比较让
 *     移动端产物在 Rollup 阶段直接丢掉该 dynamic import）；
 *   - 未注册时全部返回安全缺省值（null / false / no-op），移动端行为不变。
 *
 * 注意：`import type` 会被 TypeScript 擦除，不影响模块图。
 */
import { useCallback, useSyncExternalStore } from 'react';
import type {
  ActivateRequest,
  LaunchRequest,
} from '@/features/workbench/core/types';
import type { WorkbenchDeactivationReason } from '@/features/workbench/core/deactivationTransaction';
import type { OpenPdfPageRequest } from '@/features/workbench/core/workbenchBus';

export type { ActivateRequest, LaunchRequest, WorkbenchDeactivationReason };
export type WorkbenchLaunchRequest = LaunchRequest;
export type WorkbenchActivateRequest = ActivateRequest;
export type WorkbenchOpenPdfRequest = OpenPdfPageRequest;

export interface WorkbenchHandoffSnapshot {
  appType: string;
  resourceId: string | null;
  innerRoute?: string;
  version: number;
  savedAt: number;
}

/** 桌面端注册实现；所有方法都必须同步可用（内部可返回 Promise）。 */
export interface WorkbenchHostBridge {
  isEnabled(): boolean;
  focusedAppTypeId(): string | null;
  workspaceActiveResourceType(): string | null;
  openAppsPanel(): void;
  toggleAppsPanel(): void;
  activate(request: WorkbenchActivateRequest): Promise<boolean>;
  launch(request: WorkbenchLaunchRequest): void;
  isPdfPageActivationType(typeId: string): boolean;
  openPdfPage(request: WorkbenchOpenPdfRequest): Promise<{ delivered: boolean }>;
  consumeHandoff(): WorkbenchHandoffSnapshot | null;
  installLegacyNavigationFallback(): void;
  hasDirtyWindows(): boolean;
  runDeactivationTransaction(reason: WorkbenchDeactivationReason): Promise<unknown>;
  flushSnapshot(): Promise<void>;
}

let bridge: WorkbenchHostBridge | null = null;
const listeners = new Set<() => void>();

/** 由桌面运行时注册/撤销实现；通知所有订阅者重新取快照。 */
export function setWorkbenchHostBridge(next: WorkbenchHostBridge | null): void {
  bridge = next;
  for (const listener of [...listeners]) listener();
}

export function getWorkbenchHostBridge(): WorkbenchHostBridge | null {
  return bridge;
}

export function subscribeWorkbenchHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 工作台内部状态变化（焦点窗、应用注册等）时由运行时调用。 */
export function notifyWorkbenchHostChanged(): void {
  for (const listener of [...listeners]) listener();
}

/** 焦点工作台应用 typeId；enabled=false（经典壳/移动端）时恒为 null。 */
export function useFocusedWorkbenchAppTypeId(enabled: boolean): string | null {
  const subscribe = useCallback((onChange: () => void) => subscribeWorkbenchHost(onChange), []);
  const getSnapshot = useCallback(
    () => (enabled && bridge ? bridge.focusedAppTypeId() : null),
    [enabled],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function isWorkbenchHostEnabled(): boolean {
  return bridge?.isEnabled() ?? false;
}

export function getWorkspaceActiveResourceType(): string | null {
  return bridge?.workspaceActiveResourceType() ?? null;
}

export function openWorkbenchAppsPanel(): void {
  bridge?.openAppsPanel();
}

export function toggleWorkbenchAppsPanel(): void {
  bridge?.toggleAppsPanel();
}

export async function activateWorkbenchApp(request: WorkbenchActivateRequest): Promise<boolean> {
  return bridge ? bridge.activate(request) : false;
}

export function launchWorkbenchApp(request: WorkbenchLaunchRequest): void {
  bridge?.launch(request);
}

export function isPdfPageActivationType(typeId: string): boolean {
  return bridge?.isPdfPageActivationType(typeId) ?? false;
}

export async function openWorkbenchPdfPage(
  request: WorkbenchOpenPdfRequest,
): Promise<{ delivered: boolean }> {
  return bridge ? bridge.openPdfPage(request) : { delivered: false };
}

export function consumeWorkbenchHandoff(): WorkbenchHandoffSnapshot | null {
  return bridge?.consumeHandoff() ?? null;
}

export function installLegacyWorkbenchNavigation(): void {
  bridge?.installLegacyNavigationFallback();
}

export function hasDirtyWorkbenchWindows(): boolean {
  return bridge?.hasDirtyWindows() ?? false;
}

export async function runWorkbenchDeactivationTransaction(
  reason: WorkbenchDeactivationReason,
): Promise<unknown> {
  return bridge ? bridge.runDeactivationTransaction(reason) : undefined;
}

export async function flushWorkbenchSnapshot(): Promise<void> {
  await bridge?.flushSnapshot();
}
