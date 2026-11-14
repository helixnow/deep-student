/** D2 组合根夹具：提供 F3 finalizer / dataSpace 恢复状态 / F2 startupGate 的最小服务面。 */
import { definePlugin } from '../api.ts';

export interface StartupFixtureConfig {
  /** `dataSpace.status().recovery_required`：模拟 Rust 恢复模式（跳过业务初始化）。 */
  recovery?: boolean;
  /** `runStartupFinalizers()` 抛错，验证失败分支不会报告业务 ready。 */
  fail?: boolean;
}

export interface StartupFixtureState {
  recovery: boolean;
  finalized: boolean;
  gateMarked: boolean;
  finalizerNames: string[];
  /** `listenWindow(main, 'fixture-targeted')` 收到的载荷，按到达顺序。 */
  received: unknown[];
}

/** profile 模块由 loader 动态导入，测试与夹具共享同一 ESM 实例；用于断言启动后的状态。 */
export const startupFixtureStates: StartupFixtureState[] = [];

export default definePlugin<StartupFixtureConfig | undefined>({
  meta: {
    id: 'fixture.startup',
    lane: 'F1-fixture',
    provides: ['dataSpace', 'storage', 'startupGate', 'startupFixture'],
  },
  apply(ctx, config) {
    const state: StartupFixtureState = {
      recovery: config?.recovery === true,
      finalized: false,
      gateMarked: false,
      finalizerNames: [],
      received: [],
    };
    startupFixtureStates.push(state);

    const finalizers: (() => void | Promise<void>)[] = [];
    const storage = {
      registerFinalizer(name: string, fn: () => void | Promise<void>): void {
        state.finalizerNames.push(name);
        finalizers.push(fn);
      },
      async runStartupFinalizers(): Promise<{ completed: string[]; skipped: string[] }> {
        if (config?.fail) throw new Error('fixture startup finalizer failed');
        for (const fn of finalizers) await fn();
        state.finalized = true;
        return { completed: [...state.finalizerNames], skipped: [] };
      },
      finalizerNames: (): readonly string[] => [...state.finalizerNames],
    };
    ctx.provide('storage', storage);
    ctx.provide('dataSpace', { status: () => ({ recovery_required: state.recovery }) });
    ctx.provide('startupGate', {
      markStartupReady: () => { state.gateMarked = true; },
      isStartupReady: () => state.gateMarked,
      waitStartupReady: async () => state.gateMarked,
      guard: () => ({ [Symbol.dispose]: () => { state.gateMarked = true; } }),
    });
    ctx.provide('startupFixture', state);

    storage.registerFinalizer('fixture.startup.finalize', () => undefined);
    ctx.backendEvents.listenWindow({ window: 'main', webview: 'main' }, 'fixture-targeted', (payload) => {
      state.received.push(payload);
    });
  },
});
