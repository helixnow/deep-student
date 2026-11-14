/**
 * 生产环境的 UI 内核装配：把现有应用注册表适配为 UiAdapters。
 * 动态 import 这些注册表，避免 ui-kernel 的静态依赖链触达业务模块（与 demo 壳的加载顺序教训一致）。
 *
 * 必需的依赖只有下面 Promise.all 里的六个（boot golden 的取证工具按这份清单回放本文件）；
 * 平台 os、导航事件模块与 `app-kernel`（供聊天等晚加载的官方 UI 半安装插件）按需惰性加载，加载失败不影响装配。
 */
import {
  UiKernel,
  type AnchorEdgesAdapter,
  type UiAdapters,
  type UiKernelOptions,
} from './kernel';
import type { AnchorEdgeRecord, SemanticAnchor } from './contracts/interop';
import type { UiPlatformOs } from './services/platform';
import { dispatchTypedEvent } from '@/events/registry';

const KNOWN_OS: readonly UiPlatformOs[] = ['macos', 'windows', 'linux', 'android', 'ios', 'web'];

let activeAppKernel: UiKernel | undefined;
let fallbackAppKernel: UiKernel | undefined;

function toDstuPath(resourceId: string): string {
  const cleaned = resourceId.trim().replace(/^\/+/, '');
  return `/${cleaned}`;
}

async function openAnchorViaHost(
  anchor: SemanticAnchor,
  options: { splitIfClosed: boolean },
): Promise<boolean> {
  if (anchor.kind === 'custom') return false;

  const hasWindow = typeof window !== 'undefined' && typeof CustomEvent === 'function';
  const hasDocument = typeof document !== 'undefined' && typeof CustomEvent === 'function';

  let workbenchEnabled = false;
  try {
    const wbHost = await import('../shared/workbenchHost');
    workbenchEnabled = wbHost.isWorkbenchHostEnabled();
  } catch {
    workbenchEnabled = false;
  }

  const navigateAppEvent = async (
    eventName: 'NAVIGATE_TO_VIEW' | 'navigateToExamSheet',
    detail: Record<string, unknown>,
  ): Promise<void> => {
    try {
      const { APP_EVENTS, dispatchAppEvent } = await import('../events/app');
      if (eventName === 'NAVIGATE_TO_VIEW') {
        dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, detail);
      } else {
        dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_EXAM_SHEET, detail as { sessionId: string });
      }
    } catch {
      if (hasWindow) {
        dispatchTypedEvent(eventName, detail);
      }
    }
  };

  switch (anchor.kind) {
    case 'pdf': {
      if (hasDocument) {
        dispatchTypedEvent('pdf-ref:open', {
          sourceId: anchor.resourceId,
          pageNumber: anchor.page,
          quote: anchor.quote,
        }, 'document');
      }
      if (hasWindow) {
        dispatchTypedEvent('DSTU_FOCUS_PDF', {
          sourceId: anchor.resourceId,
          page: anchor.page,
          rect: anchor.rect,
          quote: anchor.quote,
          splitIfClosed: options.splitIfClosed,
        });
      }
      if (!workbenchEnabled) {
        await navigateAppEvent('NAVIGATE_TO_VIEW', {
          view: 'learning-hub',
          openResource: toDstuPath(anchor.resourceId),
        });
      }
      return true;
    }
    case 'media': {
      const seconds = anchor.startMs / 1000;
      if (hasDocument) {
        dispatchTypedEvent('media-ref:open', {
          resourceId: anchor.resourceId,
          seconds,
        }, 'document');
      }
      if (hasWindow) {
        dispatchTypedEvent('DSTU_FOCUS_MEDIA', {
          resourceId: anchor.resourceId,
          seconds,
          startMs: anchor.startMs,
          endMs: anchor.endMs,
          quote: anchor.quote,
          splitIfClosed: options.splitIfClosed,
        });
      }
      if (!workbenchEnabled) {
        await navigateAppEvent('NAVIGATE_TO_VIEW', {
          view: 'learning-hub',
          openResource: toDstuPath(anchor.resourceId),
        });
      }
      return true;
    }
    case 'note': {
      if (hasWindow) {
        dispatchTypedEvent('DSTU_OPEN_NOTE', {
          noteId: anchor.resourceId,
          blockId: anchor.blockId,
          heading: anchor.heading,
        });
        return true;
      }
      return false;
    }
    case 'mindmap': {
      // The workbench bridge owns NAVIGATE_TO_VIEW. Launching here too opens a second Notes window.
      await navigateAppEvent('NAVIGATE_TO_VIEW', {
        view: 'learning-hub',
        openResource: toDstuPath(anchor.resourceId),
      });
      if (hasWindow) {
        dispatchTypedEvent('DSTU_FOCUS_MINDMAP', {
          mindmapId: anchor.resourceId,
          nodeId: anchor.nodeId,
          splitIfClosed: options.splitIfClosed,
        });
      }
      return true;
    }
    case 'qbank': {
      await navigateAppEvent('navigateToExamSheet', {
        sessionId: anchor.resourceId,
      });
      if (hasWindow) {
        dispatchTypedEvent('DSTU_FOCUS_QBANK', {
          bankId: anchor.resourceId,
          questionId: anchor.questionId,
          splitIfClosed: options.splitIfClosed,
        });
      }
      return true;
    }
    case 'epub': {
      await navigateAppEvent('NAVIGATE_TO_VIEW', {
        view: 'learning-hub',
        openResource: toDstuPath(anchor.resourceId),
      });
      return true;
    }
  }
}

function createTauriAnchorEdgesAdapter(): AnchorEdgesAdapter {
  return {
    upsert: async (edges: AnchorEdgeRecord[]) => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('vfs_anchor_edges_upsert', {
          edges: edges.map((edge) => ({
            ...edge,
            targetRectJson: edge.targetRect ? JSON.stringify(edge.targetRect) : null,
          })),
        });
      } catch {
        // Graceful no-op when Rust command is absent (pre-merge lane or frontend-only unit tests).
      }
    },
    deleteBySource: async (params) => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('vfs_anchor_edges_delete_by_source', {
          sourceKind: params.sourceKind,
          sourceResourceId: params.sourceResourceId,
          ...(params.keepEdgeIds ? { keepEdgeIds: params.keepEdgeIds } : {}),
        });
      } catch {
        // Graceful no-op when Rust command is absent.
      }
    },
    queryByTarget: async (params) => {
      try {
        const [{ invoke }, { normalizePersistedAnchorEdgeRecord }] = await Promise.all([
          import('@tauri-apps/api/core'),
          import('./contracts/interop'),
        ]);
        const raw = await invoke<unknown>('vfs_anchor_edges_query_by_target', {
          targetResourceIds: params.targetResourceIds,
          ...(params.targetKind ? { targetKind: params.targetKind } : {}),
        });
        if (!Array.isArray(raw)) return [];
        return raw
          .map((row) => normalizePersistedAnchorEdgeRecord(row))
          .filter((row): row is AnchorEdgeRecord => row !== null);
      } catch {
        return [];
      }
    },
  };
}

/**
 * Returns the active `UiKernel` created by `createAppUiKernel()`, or a shared
 * standalone fallback `UiKernel` in isolated unit/component tests.
 */
export function getAppKernel(): UiKernel {
  if (activeAppKernel) return activeAppKernel;
  if (!fallbackAppKernel) {
    fallbackAppKernel = new UiKernel({
      openAnchor: openAnchorViaHost,
      anchorEdges: createTauriAnchorEdgesAdapter(),
    });
  }
  return fallbackAppKernel;
}

/** `options` 只给测试固定内核模式；应用入口不传，沿用内核缺省。 */
export async function createAppUiKernel(options: UiKernelOptions = {}): Promise<UiKernel> {
  const [{ commandRegistry }, { blockRegistry, eventRegistry, modeRegistry }, { appRegistry }, { default: i18n }, { installOfficialUiPlugins }] = await Promise.all([
    import('../command-palette/registry/commandRegistry'),
    import('../features/chat/registry/blockRegistry'),
    import('../features/workbench/core/appRegistry'),
    import('../i18n'),
    import('../ui-plugins/official/install'),
  ]);
  const adapters: UiAdapters = {
    legacyRegistries: { commandRegistry, blockRegistry, appRegistry, eventRegistry, modeRegistry },
    i18n: {
      addBundle: (lng, ns, resources) => {
        // 官方插件可以向已有命名空间追加文案；撤销时恢复原包，而不是删掉整个命名空间。
        const previous = i18n.hasResourceBundle(lng, ns) ? JSON.parse(JSON.stringify(i18n.getResourceBundle(lng, ns))) : undefined;
        i18n.addResourceBundle(lng, ns, resources, true, true);
        return () => {
          i18n.removeResourceBundle(lng, ns);
          if (previous) i18n.addResourceBundle(lng, ns, previous, true, true);
        };
      },
      languages: () => (i18n.languages?.length ? i18n.languages : [i18n.language]),
      onLanguageChanged: (listener) => {
        i18n.on('languageChanged', listener);
        return () => i18n.off('languageChanged', listener);
      },
      isReservedNamespace: (ns) => ([] as readonly string[]).concat(i18n.options.ns ?? []).includes(ns),
    },
    // 平台缺省即桌面实现（UiKernel 内的 createDesktopPlatform）；移动端外壳桥在 FE-A5 传入 `platform`。
    navigate: ({ view, params }) => {
      void import('../events/app')
        .then(({ APP_EVENTS, dispatchAppEvent }) => dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { ...params, view }))
        .catch((error) => console.error('[ui-kernel] navigation failed', error));
    },
    invoke: (command, args) => import('@tauri-apps/api/core').then(({ invoke }) => invoke(command, args)),
    // RUST-FIX(RF-W17-host-event-own-prefix): `ctx.ui.host.on` 的传输；订阅哪个事件由内核按插件命名空间校验
    // `ctx.ui.host.on`: Host → UI push events, the same Tauri event transport the shell exports.
    events: {
      listen: (event, handler) => import('@tauri-apps/api/event')
        .then(({ listen }) => listen(event, (received) => handler(received.payload))),
    },
    openAnchor: openAnchorViaHost,
    anchorEdges: createTauriAnchorEdgesAdapter(),
  };
  const kernel = new UiKernel(adapters, options);
  const baseDispose = kernel.dispose.bind(kernel);
  kernel.dispose = async () => {
    if (activeAppKernel === kernel) activeAppKernel = undefined;
    await baseDispose();
  };
  void import('../utils/platform')
    .then(({ getPlatform }) => {
      const os = getPlatform() as UiPlatformOs;
      if (KNOWN_OS.includes(os)) kernel.platform.update({ os });
    })
    .catch(() => {
      // 平台细节是补充信息；拿不到时保持 os: 'unknown'。
    });
  try {
    await import('../app/pluginWorkshop');
    await installOfficialUiPlugins(kernel);
    // Published Host manager contract is now available. The settings owner's lazy point supplies ctx.ui.hostStatus.
    await import('../features/plugin-manager/production');
    activeAppKernel = kernel;
    void import('./app-kernel')
      .then(({ provideAppUiKernel }) => provideAppUiKernel(kernel))
      .catch(() => {
        // 晚加载的官方 UI 半拿不到内核时，仍按模块导入登记的内置条目工作。
      });
    return kernel;
  } catch (error) {
    await kernel.dispose();
    throw error;
  }
}
