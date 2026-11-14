/**
 * D2 真实组合夹具：通过生产 `serveHost` 安装 F3 的 `StorageCordisService`
 * （真实 `StartupFinalizerRegistry`）与 F2 的 `createStartupGate`。
 *
 * 这个夹具只负责把真实服务放进 profile；finalizer 的注册、排序、失败与重试语义全部由
 * F3 实现执行，不使用同义替身。`dataSpace.status()` 是恢复模式探针的最小服务面。
 */
import { definePlugin } from '../api.ts';
import { StorageCordisService } from '../../platform/storage/service.ts';
import type { StorageService } from '../../platform/storage/api.ts';
import { createStartupGate } from '../../../electron/startup-gate.ts';
import type { StartupGate } from '../../../electron/api.ts';

export interface RealStartupFixtureConfig {
  /** `dataSpace.status().recovery_required`：模拟 Rust 恢复模式（跳过业务初始化）。 */
  recovery?: boolean;
  /** 让 `fixture.startup-real.restore` 抛错，验证真实 finalizer 失败链。 */
  failFinalizer?: boolean;
}

export interface RealStartupFixtureState {
  recovery: boolean;
  gate: StartupGate;
  storage: StorageService;
  /** finalizer 实际执行顺序。 */
  runs: string[];
  /** 每次 finalizer 执行时 `startupGate.isStartupReady()` 的快照（应全为 false）。 */
  gateReadyAtRun: boolean[];
}

/** profile 模块由 loader 动态导入，测试与夹具共享同一 ESM 实例。 */
export const realStartupStates: RealStartupFixtureState[] = [];

export default definePlugin<RealStartupFixtureConfig | undefined>({
  meta: {
    id: 'fixture.startup-real',
    lane: 'F1-fixture',
    provides: ['storage', 'dataSpace', 'startupGate', 'startupReal'],
  },
  apply(ctx, config) {
    // 生产路径：StorageCordisService 构造时把自身注册为 ctx.storage；测试通过同一服务面操作
    // 真实 StartupFinalizerRegistry，而不是直接调用实现类的内部字段。
    new StorageCordisService(ctx, { dataLocalDir: ctx.app.dataDir });
    const state: RealStartupFixtureState = {
      recovery: config?.recovery === true,
      gate: createStartupGate(),
      storage: ctx.storage,
      runs: [],
      gateReadyAtRun: [],
    };
    realStartupStates.push(state);
    ctx.provide('dataSpace', { status: () => ({ recovery_required: state.recovery }) });
    ctx.provide('startupGate', state.gate);
    ctx.provide('startupReal', state);

    state.storage.registerFinalizer('fixture.startup-real.migrate', () => {
      state.runs.push('migrate');
      state.gateReadyAtRun.push(state.gate.isStartupReady());
    });
    state.storage.registerFinalizer('fixture.startup-real.restore', () => {
      state.runs.push('restore');
      state.gateReadyAtRun.push(state.gate.isStartupReady());
      if (config?.failFinalizer === true) throw new Error('real restore finalizer failed');
    }, { after: ['fixture.startup-real.migrate'] });
    state.storage.registerFinalizer('fixture.startup-real.cleanup', () => {
      state.runs.push('cleanup');
      state.gateReadyAtRun.push(state.gate.isStartupReady());
    }, { after: ['fixture.startup-real.restore'] });
  },
});
