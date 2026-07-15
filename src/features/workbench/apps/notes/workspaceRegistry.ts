/**
 * Runtime bridge between the single Notes application window and resource-level callers.
 *
 * Notes and mindmaps remain separate resource types. The registry only records which
 * Notes workspace hosts (and currently displays) each resource so OS routing and ACR do
 * not need to treat an internal tab as a standalone workbench window.
 */
import {
  getMindMapStoreForWindow,
  getMindMapStoreForResource,
  subscribeMindMapStoreReady,
  subscribeMindMapStoreReadyForWindow,
  type MindMapStoreApi,
} from '@/features/mindmap/store/mindmapStore';
import { findNodeById } from '@/features/mindmap/utils/node/find';
import {
  getNoteEditor,
  subscribeNoteEditorReady,
} from '@/features/workbench/agent/drivers/noteDriver';
import type { ActivationResult } from '@/features/workbench/core/types';

export type NotesWorkspaceResourceType = 'note' | 'mindmap';

export interface NotesWorkspaceResourceRef {
  type: NotesWorkspaceResourceType;
  id: string;
}

export interface NotesWorkspaceResourceDetails extends NotesWorkspaceResourceRef {
  title?: string;
  saveState?: 'saved' | 'saving' | 'dirty';
}

export interface NotesWorkspaceHostController {
  /** Select an existing tab or create one. Resolve after its content surface is mounted. */
  openResource: (resource: NotesWorkspaceResourceRef) => void | Promise<void>;
  closeResource?: (resource: NotesWorkspaceResourceRef) => void | Promise<void>;
  /** Whether any internal tab has edits that must be confirmed before closing the OS window. */
  hasUnsavedChanges?: () => boolean;
  getActiveResource?: () => NotesWorkspaceResourceRef | null;
  listResources?: () => readonly NotesWorkspaceResourceRef[];
  /** Bounded, presentation-safe tab metadata for ACR observation. */
  listResourceDetails?: () => readonly NotesWorkspaceResourceDetails[];
}

export interface NotesWorkspaceState {
  hosts: readonly string[];
  activeByWindow: ReadonlyMap<string, NotesWorkspaceResourceRef | null>;
}

type Listener = (state: NotesWorkspaceState) => void;

interface HostRecord {
  controller: NotesWorkspaceHostController;
  active: NotesWorkspaceResourceRef | null;
  registeredAt: number;
}

const hosts = new Map<string, HostRecord>();
const resourceHosts = new Map<string, string>();
const listeners = new Set<Listener>();
interface PendingOpen {
  resource: NotesWorkspaceResourceRef;
  preferredWindowId?: string;
  resolve: (windowId: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingOpens: PendingOpen[] = [];
let registrationSequence = 0;
const HOST_READY_TIMEOUT_MS = 10_000;
const RESOURCE_READY_TIMEOUT_MS = 8_000;

function normalizeResource(resource: NotesWorkspaceResourceRef): NotesWorkspaceResourceRef {
  return { type: resource.type, id: resource.id.trim() };
}

function resourceKey(resource: NotesWorkspaceResourceRef): string {
  return `${resource.type}:${resource.id}`;
}

function sameResource(
  left: NotesWorkspaceResourceRef | null | undefined,
  right: NotesWorkspaceResourceRef | null | undefined,
): boolean {
  return Boolean(left && right && left.type === right.type && left.id === right.id);
}

function snapshot(): NotesWorkspaceState {
  return {
    hosts: [...hosts.keys()],
    activeByWindow: new Map(
      [...hosts].map(([windowId, record]) => [windowId, record.active] as const),
    ),
  };
}

function emit(): void {
  const state = snapshot();
  for (const listener of listeners) listener(state);
}

function chooseHost(preferredWindowId?: string): [string, HostRecord] | null {
  if (preferredWindowId) {
    const preferred = hosts.get(preferredWindowId);
    if (preferred) return [preferredWindowId, preferred];
  }
  let selected: [string, HostRecord] | null = null;
  for (const entry of hosts) {
    if (!selected || entry[1].registeredAt > selected[1].registeredAt) selected = entry;
  }
  return selected;
}

/** Register the controller owned by a mounted Notes app window. */
export function registerWorkspaceHost(
  windowId: string,
  controller: NotesWorkspaceHostController,
): () => void {
  const existing = hosts.get(windowId);
  const active = controller.getActiveResource?.() ?? existing?.active ?? null;
  hosts.set(windowId, {
    controller,
    active,
    registeredAt: ++registrationSequence,
  });
  if (active?.id) resourceHosts.set(resourceKey(active), windowId);
  emit();
  for (const pending of [...pendingOpens]) {
    if (pending.preferredWindowId && pending.preferredWindowId !== windowId) continue;
    const index = pendingOpens.indexOf(pending);
    if (index >= 0) pendingOpens.splice(index, 1);
    clearTimeout(pending.timer);
    void openOnHost(windowId, hosts.get(windowId)!, pending.resource)
      .then(pending.resolve)
      .catch(() => pending.resolve(null));
  }

  return () => {
    if (hosts.get(windowId)?.controller !== controller) return;
    hosts.delete(windowId);
    for (const [key, ownerWindowId] of resourceHosts) {
      if (ownerWindowId === windowId) resourceHosts.delete(key);
    }
    emit();
  };
}

/** Keep the active internal tab synchronized with focus binding and resource probing. */
export function setWorkspaceActiveResource(
  windowId: string,
  resource: NotesWorkspaceResourceRef | null,
): void {
  const host = hosts.get(windowId);
  if (!host) return;
  const normalized = resource ? normalizeResource(resource) : null;
  if (normalized && !normalized.id) return;
  if (sameResource(host.active, normalized) || (!host.active && !normalized)) return;
  host.active = normalized;
  if (normalized) resourceHosts.set(resourceKey(normalized), windowId);
  emit();
}

export function getWorkspaceActiveResource(
  windowId?: string,
): NotesWorkspaceResourceRef | null {
  if (windowId) {
    const host = hosts.get(windowId);
    return host?.controller.getActiveResource?.() ?? host?.active ?? null;
  }
  const selected = chooseHost();
  if (!selected) return null;
  return selected[1].controller.getActiveResource?.() ?? selected[1].active ?? null;
}

/** Resolve the Notes app window currently hosting (or last asked to host) a resource. */
export function findWorkspaceHostForResource(
  resource: NotesWorkspaceResourceRef,
): string | null {
  const normalized = normalizeResource(resource);
  const mapped = resourceHosts.get(resourceKey(normalized));
  if (mapped && hosts.has(mapped)) return mapped;
  for (const [windowId, host] of hosts) {
    const active = host.controller.getActiveResource?.() ?? host.active;
    if (sameResource(active, normalized)) return windowId;
  }
  return null;
}

/** Open/select a resource in a mounted workspace and return its workbench window id. */
export async function requestWorkspaceResource(
  resource: NotesWorkspaceResourceRef,
  preferredWindowId?: string,
): Promise<string | null> {
  const normalized = normalizeResource(resource);
  if (!normalized.id) return null;
  const mappedWindowId = findWorkspaceHostForResource(normalized);
  const selected = chooseHost(preferredWindowId ?? mappedWindowId ?? undefined);
  if (!selected) {
    return new Promise<string | null>((resolve) => {
      const pending: PendingOpen = {
        resource: normalized,
        preferredWindowId,
        resolve,
        timer: setTimeout(() => {
          const index = pendingOpens.indexOf(pending);
          if (index >= 0) pendingOpens.splice(index, 1);
          resolve(null);
        }, HOST_READY_TIMEOUT_MS),
      };
      pendingOpens.push(pending);
    });
  }
  const [windowId, host] = selected;
  return openOnHost(windowId, host, normalized);
}

async function openOnHost(
  windowId: string,
  host: HostRecord,
  resource: NotesWorkspaceResourceRef,
): Promise<string> {
  const normalized = normalizeResource(resource);
  resourceHosts.set(resourceKey(normalized), windowId);
  await host.controller.openResource(normalized);
  // UI normally reports this from its tab effect. Recording it here also makes an
  // imperative controller safe for ACR commands issued in the same microtask.
  setWorkspaceActiveResource(windowId, normalized);
  return windowId;
}

/** Close a resource tab without closing the shared Notes application window. */
export async function closeWorkspaceResource(
  resource: NotesWorkspaceResourceRef,
): Promise<boolean> {
  const normalized = normalizeResource(resource);
  if (!normalized.id) return false;
  const mappedWindowId = findWorkspaceHostForResource(normalized);
  const targets = mappedWindowId
    ? ([[mappedWindowId, hosts.get(mappedWindowId)!]] as const)
    : [...hosts];
  let handled = false;
  for (const [windowId, host] of targets) {
    if (!host?.controller.closeResource) continue;
    await host.controller.closeResource(normalized);
    handled = true;
    if (sameResource(host.active, normalized)) host.active = null;
    if (resourceHosts.get(resourceKey(normalized)) === windowId) {
      resourceHosts.delete(resourceKey(normalized));
    }
  }
  if (handled) emit();
  return handled;
}

/** Remove routing state after the user closes an internal tab directly in the UI. */
export function forgetWorkspaceResource(
  resource: NotesWorkspaceResourceRef,
  windowId?: string,
): void {
  const normalized = normalizeResource(resource);
  const key = resourceKey(normalized);
  const owner = resourceHosts.get(key);
  if (owner && (!windowId || owner === windowId)) resourceHosts.delete(key);
  const host = windowId ? hosts.get(windowId) : owner ? hosts.get(owner) : undefined;
  if (host && sameResource(host.active, normalized)) host.active = null;
  emit();
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

async function waitForNoteEditor(resourceId: string, windowId?: string) {
  const ready = getNoteEditor(resourceId, windowId);
  if (ready) return ready;
  return new Promise<ReturnType<typeof getNoteEditor>>((resolve) => {
    let cancel = () => undefined;
    const timer = setTimeout(() => {
      cancel();
      resolve(undefined);
    }, RESOURCE_READY_TIMEOUT_MS);
    cancel = subscribeNoteEditorReady(resourceId, (api) => {
      clearTimeout(timer);
      cancel();
      resolve(api);
    }, windowId);
  });
}

async function waitForMindmapStore(
  resourceId: string,
  windowId?: string,
): Promise<MindMapStoreApi | null> {
  const ready = windowId
    ? getMindMapStoreForWindow(windowId, resourceId)
    : getMindMapStoreForResource(resourceId);
  if (ready?.getState().mindmapId === resourceId) return ready;
  return new Promise((resolve) => {
    let cancel = () => undefined;
    const timer = setTimeout(() => {
      cancel();
      resolve(null);
    }, RESOURCE_READY_TIMEOUT_MS);
    const onReady = (store: MindMapStoreApi) => {
      clearTimeout(timer);
      cancel();
      resolve(store);
    };
    cancel = windowId
      ? subscribeMindMapStoreReadyForWindow(resourceId, windowId, onReady)
      : subscribeMindMapStoreReady(resourceId, onReady);
  });
}

/** Select and await the resource surface used by streaming ACR driver operations. */
export async function prepareWorkspaceResource(
  resource: NotesWorkspaceResourceRef,
  preferredWindowId?: string,
): Promise<string | null> {
  const windowId = await requestWorkspaceResource(resource, preferredWindowId);
  if (!windowId) return null;
  const ready = resource.type === 'note'
    ? await waitForNoteEditor(resource.id, windowId)
    : await waitForMindmapStore(resource.id, windowId);
  return ready ? windowId : null;
}

/** Select a resource, await its editor/store, and deliver an ACR app command. */
export async function activateWorkspaceResource(
  resource: NotesWorkspaceResourceRef,
  action: string,
  payload?: unknown,
  preferredWindowId?: string,
): Promise<{ windowId: string | null; result: ActivationResult }> {
  const windowId = await requestWorkspaceResource(resource, preferredWindowId);
  if (!windowId) {
    return {
      windowId: null,
      result: { handled: false, code: 'ACTIVATION_NOT_READY', hint: '笔记应用尚未就绪' },
    };
  }

  if (resource.type === 'note') {
    if (action !== 'scrollToHeading') {
      return { windowId, result: { handled: false, code: 'UNKNOWN_ACTION' } };
    }
    const p = payloadRecord(payload);
    const heading = typeof payload === 'string'
      ? payload
      : typeof p?.heading === 'string'
        ? p.heading
        : typeof p?.text === 'string'
          ? p.text
          : '';
    const level = typeof p?.level === 'number' && p.level >= 1 && p.level <= 6
      ? p.level
      : 1;
    if (!heading.trim()) {
      return {
        windowId,
        result: { handled: false, code: 'INVALID_ARGS', hint: 'scrollToHeading 需要 payload.heading' },
      };
    }
    const editor = await waitForNoteEditor(resource.id);
    if (!editor) {
      return {
        windowId,
        result: { handled: false, code: 'ANCHOR_NOT_FOUND', hint: '笔记编辑器未能完成挂载' },
      };
    }
    editor.scrollToHeading(heading, level);
    return { windowId, result: { handled: true } };
  }

  const p = payloadRecord(payload);
  if (action === 'focusNode') {
    const nodeId =
      (typeof p?.nodeId === 'string' && p.nodeId) ||
      (typeof p?.node_id === 'string' && p.node_id) ||
      '';
    if (!nodeId) {
      return { windowId, result: { handled: false, code: 'INVALID_ARGS' } };
    }
    const store = await waitForMindmapStore(resource.id, windowId);
    if (!store) {
      return { windowId, result: { handled: false, code: 'MINDMAP_NOT_READY' } };
    }
    if (!findNodeById(store.getState().document.root, nodeId)) {
      return { windowId, result: { handled: false, code: 'NODE_NOT_FOUND' } };
    }
    store.getState().expandToNode(nodeId, { silent: true });
    store.getState().setFocusedNodeId(nodeId);
    return { windowId, result: { handled: true } };
  }
  if (action === 'setView') {
    const view = p?.view;
    if (view !== 'outline' && view !== 'mindmap') {
      return { windowId, result: { handled: false, code: 'INVALID_ARGS' } };
    }
    const store = await waitForMindmapStore(resource.id, windowId);
    if (!store) {
      return { windowId, result: { handled: false, code: 'MINDMAP_NOT_READY' } };
    }
    store.getState().setCurrentView(view);
    return { windowId, result: { handled: true } };
  }
  if (action === 'search') {
    const query = typeof p?.query === 'string' ? p.query : '';
    const store = await waitForMindmapStore(resource.id, windowId);
    if (!store) {
      return { windowId, result: { handled: false, code: 'MINDMAP_NOT_READY' } };
    }
    store.getState().search(query);
    return { windowId, result: { handled: true } };
  }
  if (action === 'nextSearchResult' || action === 'previousSearchResult') {
    const store = await waitForMindmapStore(resource.id, windowId);
    if (!store) {
      return { windowId, result: { handled: false, code: 'MINDMAP_NOT_READY' } };
    }
    if (action === 'nextSearchResult') store.getState().nextSearchResult();
    else store.getState().prevSearchResult();
    return { windowId, result: { handled: true } };
  }
  if (action === 'clearSearch') {
    const store = await waitForMindmapStore(resource.id, windowId);
    if (!store) {
      return { windowId, result: { handled: false, code: 'MINDMAP_NOT_READY' } };
    }
    store.getState().clearSearch();
    return { windowId, result: { handled: true } };
  }
  return { windowId, result: { handled: false, code: 'UNKNOWN_ACTION' } };
}

export function subscribeWorkspaceState(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNotesWorkspaceState(): NotesWorkspaceState {
  return snapshot();
}

export function getWorkspaceOpenResources(): readonly NotesWorkspaceResourceRef[] {
  const resources = new Map<string, NotesWorkspaceResourceRef>();
  const authoritativeHosts = new Set<string>();
  for (const [windowId, host] of hosts) {
    if (host.controller.listResources) authoritativeHosts.add(windowId);
    for (const resource of host.controller.listResources?.() ?? []) {
      const normalized = normalizeResource(resource);
      if (normalized.id) resources.set(resourceKey(normalized), normalized);
    }
  }
  for (const [key, windowId] of resourceHosts) {
    if (authoritativeHosts.has(windowId)) continue;
    const separator = key.indexOf(':');
    const type = key.slice(0, separator);
    const id = key.slice(separator + 1);
    if ((type === 'note' || type === 'mindmap') && id) {
      resources.set(key, { type, id });
    }
  }
  return [...resources.values()];
}

/**
 * Query every mounted Notes workspace before a shared Notes OS window closes.
 * A checker failure is treated as dirty so a broken editor integration cannot
 * silently discard in-memory changes.
 */
export function hasUnsavedNotesWorkspaceChanges(): boolean {
  for (const { controller } of hosts.values()) {
    try {
      if (controller.hasUnsavedChanges?.()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** Return only the tabs hosted by one Notes window; never falls back to other hosts. */
export function getWorkspaceResourcesForWindow(
  windowId: string,
): readonly NotesWorkspaceResourceDetails[] {
  const host = hosts.get(windowId);
  if (!host) return [];
  const detailed = host.controller.listResourceDetails?.();
  if (detailed) {
    return detailed
      .map((resource) => ({ ...resource, id: resource.id.trim() }))
      .filter((resource) => resource.id.length > 0);
  }
  return (host.controller.listResources?.() ?? []).map(normalizeResource);
}

/** Test-only reset for this process-global runtime registry. */
export function resetWorkspaceRegistryForTests(): void {
  for (const pending of pendingOpens) {
    clearTimeout(pending.timer);
    pending.resolve(null);
  }
  pendingOpens.length = 0;
  hosts.clear();
  resourceHosts.clear();
  listeners.clear();
  registrationSequence = 0;
}
