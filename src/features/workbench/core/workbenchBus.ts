/**
 * workbenchBus — 三分打开语义（launch / activate / project）+ legacy 降级
 *
 * 主责 P1（可完善内部实现），接口冻结。
 * 业务模块只 import { workbenchBus } from '@/features/workbench'。
 *
 * legacy 降级：workbench 未启用时，launch/activate 转发为现有 CustomEvent
 * 导航（映射表由接线代理 P11 补全 registerLegacyFallback）。
 */
import type {
  ActivateRequest,
  ActivationResult,
  LaunchRequest,
  ProjectRequest,
} from './types';
import { appRegistry } from './appRegistry';
import { useWindowStore } from './windowStore';

export type LegacyFallbackHandler = (req: LaunchRequest | ActivateRequest, kind: 'launch' | 'activate') => void;

let enabled = false;
let legacyFallback: LegacyFallbackHandler | null = null;

/** 最近一次 activate 的 onActivation 结构化回执（供 StageManager app_command） */
let lastActivationResult: ActivationResult | null = null;

function normalizeActivationResult(raw: void | ActivationResult | boolean): ActivationResult {
  if (raw === false) return { handled: false };
  if (raw && typeof raw === 'object' && 'handled' in raw) {
    return {
      handled: Boolean(raw.handled),
      code: typeof raw.code === 'string' ? raw.code : undefined,
      hint: typeof raw.hint === 'string' ? raw.hint : undefined,
      message: typeof raw.message === 'string' ? raw.message : undefined,
    };
  }
  return { handled: true };
}

export const workbenchBus = {
  /** 由设置层（P10）在开关变化时调用 */
  setEnabled(value: boolean): void {
    enabled = value;
  },

  isEnabled(): boolean {
    return enabled;
  },

  /** 由接线代理（P11）注册：开关关闭时把请求翻译回现有 CustomEvent 导航 */
  registerLegacyFallback(handler: LegacyFallbackHandler): void {
    legacyFallback = handler;
  },

  /** 打开应用：multi+同 instanceKey → focus 已有；single → focus 或新建 */
  launch(req: LaunchRequest): string | null {
    if (!enabled) {
      legacyFallback?.(req, 'launch');
      return null;
    }
    const store = useWindowStore.getState();
    return store.openWindow({
      typeId: req.typeId,
      instanceKey: req.instanceKey ?? null,
      payload: req.payload,
    });
  },

  /** 读取并清空最近一次 activate 的结构化回执 */
  consumeLastActivationResult(): ActivationResult | null {
    const r = lastActivationResult;
    lastActivationResult = null;
    return r;
  },

  /** 对已存在窗口发一次性指令；不存在且有 fallbackLaunch 则先 launch */
  activate(req: ActivateRequest): boolean {
    lastActivationResult = null;
    if (!enabled) {
      legacyFallback?.(req, 'activate');
      lastActivationResult = {
        handled: false,
        code: 'WORKBENCH_DISABLED',
        hint: '桌面模式未开启',
      };
      return false;
    }
    const store = useWindowStore.getState();
    // R2-04：single 按 typeId；multi 精确 instanceKey；空 key 回落焦点窗/同 type 首窗
    const def = appRegistry.get(req.typeId);
    let win: (typeof store.windows)[string] | undefined;
    if (def?.instanceMode === 'single') {
      win = Object.values(store.windows).find((w) => w.typeId === req.typeId);
    } else if (req.instanceKey) {
      win = Object.values(store.windows).find(
        (w) => w.typeId === req.typeId && w.instanceKey === req.instanceKey,
      );
    } else {
      const focusedId = store.focusStack[store.focusStack.length - 1];
      const focused = focusedId ? store.windows[focusedId] : undefined;
      if (focused?.typeId === req.typeId) {
        win = focused;
      } else {
        win = Object.values(store.windows).find((w) => w.typeId === req.typeId);
      }
    }
    if (!win && req.fallbackLaunch) {
      const id = workbenchBus.launch(req.fallbackLaunch);
      win = id ? store.windows[id] ?? useWindowStore.getState().windows[id] : undefined;
    }
    if (!win) {
      lastActivationResult = {
        handled: false,
        code: 'WINDOW_NOT_FOUND',
        hint: '目标窗口未打开；可先 open_app 或带 fallbackLaunch',
      };
      return false;
    }
    useWindowStore.getState().focusWindow(win.id);
    const raw = def?.onActivation?.({
      windowId: win.id,
      instanceKey: win.instanceKey,
      action: req.action,
      payload: req.payload,
    });
    const detail = normalizeActivationResult(raw);
    lastActivationResult = detail;
    // 布尔返回值仍表示「窗已命中并送达指令」；业务拒绝看 consumeLastActivationResult().handled
    return true;
  },

  /** 长活业务实例投射：实例出现 → 保证有窗；结束由宿主 closeWindow */
  project(req: ProjectRequest): string | null {
    if (!enabled) return null;
    const store = useWindowStore.getState();
    const existing = Object.values(store.windows).find(
      (w) => w.typeId === req.typeId && w.instanceKey === req.instanceKey,
    );
    if (existing) return existing.id;
    return store.openWindow({
      typeId: req.typeId,
      instanceKey: req.instanceKey,
      title: req.title,
      initialFrame: req.initialFrame,
    });
  },

  /** 关闭（走 canClose 拦截） */
  async closeWindow(id: string): Promise<boolean> {
    const store = useWindowStore.getState();
    const win = store.windows[id];
    if (!win) return true;
    const def = appRegistry.get(win.typeId);
    if (def?.canClose) {
      const ok = await def.canClose(win.instanceKey);
      if (!ok) return false;
    }
    useWindowStore.getState().closeWindow(id);
    return true;
  },
};
